import { parse } from "@babel/parser";
import { ConfigError } from "../errors.js";
import { buildPrompt, extractJson, extractMessageContent, text, truncate } from "./prompt.js";
import { ModelError, ProposalError, validateProposal } from "./proposal.js";
import { renderProposal } from "./render.js";

import { getVercelOidcToken } from "@vercel/oidc";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_MAX_ARGS_BYTES = 4096;
const MAX_DETAIL_CHARS = 400;

/**
 * Normalize a configured base URL to the OpenAI-compatible `/v1` root. A base
 * URL may arrive with or without the trailing `/v1`.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeBaseUrl(baseUrl) {
  const trimmed = text(baseUrl).trim();
  if (!trimmed) return "";
  const withoutSlash = trimmed.replace(/\/+$/, "");
  return /\/v1$/i.test(withoutSlash) ? withoutSlash : `${withoutSlash}/v1`;
}

/**
 * Collect the exported names the model is allowed to choose. This mirrors the
 * supported source forms but intentionally does not enforce the input policy;
 * validate-input.js owns that.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function deriveExportNames(source) {
  let ast;
  try {
    ast = parse(String(source ?? ""), {
      sourceType: "module",
      allowReturnOutsideFunction: false,
    });
  } catch {
    return [];
  }

  const names = [];
  const add = (name) => {
    if (typeof name === "string" && name.length > 0 && !names.includes(name)) names.push(name);
  };

  for (const node of ast.program.body) {
    if (!node || node.type !== "ExportNamedDeclaration") continue;

    const declaration = node.declaration;
    if (declaration?.type === "FunctionDeclaration") {
      add(declaration.id?.name);
    } else if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? []) {
        const init = declarator.init;
        const isFunction =
          init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression";
        if (isFunction && declarator.id?.type === "Identifier") add(declarator.id.name);
      }
    }

    for (const specifier of node.specifiers ?? []) {
      const exported = specifier.exported;
      if (exported?.type === "Identifier") add(exported.name);
      else if (typeof exported?.value === "string") add(exported.value);
    }
  }

  return names;
}

function resolveDriver(model) {
  const driver = text(model.driver || "auto").trim().toLowerCase();
  const hasBase = Boolean(text(model.baseUrl).trim());
  const hasId = Boolean(text(model.id).trim());

  if (driver === "auto" || driver === "") {
    return hasBase && hasId ? "openai-compatible" : "unconfigured";
  }
  if (driver === "ollama") return "openai-compatible";
  return driver;
}

function resolveBaseUrl(model) {
  const configured = normalizeBaseUrl(model.baseUrl);
  if (configured) return configured;
  if (text(model.driver).trim().toLowerCase() === "ollama") return normalizeBaseUrl(DEFAULT_BASE_URL);
  return "";
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function errorDetail(value) {
  const cleaned = text(value).replace(/\s+/g, " ").trim();
  return truncate(cleaned, MAX_DETAIL_CHARS);
}

async function readResponseText(response) {
  try {
    if (response && typeof response.text === "function") return await response.text();
    if (response && typeof response.json === "function") {
      const body = await response.json();
      return typeof body === "string" ? body : JSON.stringify(body);
    }
  } catch {
    return "";
  }
  return "";
}

async function readResponseJson(response) {
  if (response && typeof response.json === "function") return await response.json();
  if (response && typeof response.text === "function") {
    const raw = await response.text();
    return JSON.parse(raw);
  }
  throw new ModelError("The model endpoint returned an empty response.");
}

/**
 * @param {{
 *   limits?: { maxArgsBytes?: number },
 *   model?: {
 *     driver?: string,
 *     baseUrl?: string,
 *     apiKey?: string,
 *     id?: string,
 *     timeoutMs?: number,
 *     temperature?: number,
 *     maxTokens?: number,
 *     responseFormat?: boolean,
 *     fetch?: typeof fetch
 *   },
 *   fetch?: typeof fetch
 * }} config
 */
export function createModel(config = {}) {
  const model = config.model ?? {};
  const driver = resolveDriver(model);

  if (driver === "unconfigured") {
    throw new ConfigError("Set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID");
  }
  if (driver !== "openai-compatible") {
    throw new ConfigError(`Unsupported model driver ${JSON.stringify(text(model.driver))}.`);
  }

  const id = text(model.id).trim();
  if (!id) throw new ConfigError("Set MODEL_ID to the model name to request.");

  const baseUrl = resolveBaseUrl(model);
  if (!baseUrl) throw new ConfigError("Set MODEL_API_BASE_URL.");

  const endpoint = `${baseUrl}/chat/completions`;
  // Vercel AI Gateway accepts the deployment's OIDC token, so a separate
  // provider key is optional on Vercel.
  const configuredKey = text(model.apiKey).trim() || text(process.env.VERCEL_OIDC_TOKEN).trim();
  const timeoutMs = positiveNumber(model.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxArgsBytes = positiveNumber(config.limits?.maxArgsBytes, DEFAULT_MAX_ARGS_BYTES);
  const includeResponseFormat = model.responseFormat !== false;
  const fetchImpl =
    typeof model.fetch === "function"
      ? model.fetch
      : typeof config.fetch === "function"
        ? config.fetch
        : globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new ConfigError("This runtime has no fetch implementation for the model driver.");
  }

  async function fetchOnce(body) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    let apiKey = configuredKey;
    if (!apiKey) {
      // Vercel AI Gateway accepts the project's short-lived OIDC token.
      try {
        apiKey = text(await getVercelOidcToken()).trim();
      } catch {
        apiKey = "";
      }
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined;

    try {
      return await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const name = error?.name;
      const message = text(error?.message);
      const timedOut = name === "TimeoutError" || name === "AbortError" || /timed?\s*out|aborted/i.test(message);
      if (timedOut) {
        throw new ModelError(
          `The model did not respond within ${timeoutMs} ms.`,
          { timeoutMs },
          { retryable: true, cause: error },
        );
      }
      throw new ModelError(
        `The model request failed: ${errorDetail(message || name || "network error")}`,
        undefined,
        { retryable: true, cause: error },
      );
    }
  }

  async function request(body) {
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      const response = await fetchOnce(body);
      if (!response || typeof response.ok !== "boolean") {
        throw new ModelError("The model endpoint returned an invalid response object.");
      }

      if (!response.ok) {
        const detail = errorDetail(await readResponseText(response));
        const status = Number(response.status ?? 0);
        const canFallback =
          attempt === 1 &&
          status === 400 &&
          Object.prototype.hasOwnProperty.call(body, "response_format") &&
          /response[_\s-]?format/i.test(detail);
        if (canFallback) {
          delete body.response_format;
          continue;
        }
        const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
        throw new ModelError(
          `The model request failed with HTTP ${status}${detail ? `: ${detail}` : "."}`,
          { status },
          { retryable },
        );
      }

      try {
        return await readResponseJson(response);
      } catch (error) {
        if (error instanceof ModelError) throw error;
        throw new ModelError(
          "The model endpoint returned a response that was not valid JSON.",
          undefined,
          { retryable: true, cause: error },
        );
      }
    }
    throw new ModelError("The model request failed.");
  }

  function decodeContent(payload) {
    if (payload?.error) {
      const message =
        typeof payload.error === "string" ? payload.error : payload.error.message || JSON.stringify(payload.error);
      throw new ModelError(`The model endpoint reported an error: ${errorDetail(message)}`, undefined, {
        retryable: true,
      });
    }

    const content = extractMessageContent(
      payload?.choices?.[0]?.message?.content ??
        payload?.message?.content ??
        payload?.response ??
        payload?.choices?.[0]?.text,
    ).trim();

    if (!content) {
      throw new ModelError("The model returned an empty response.", undefined, { retryable: true });
    }
    return content;
  }

  return {
    /**
     * @param {{
     *   requirement: string,
     *   source: string,
     *   tests: string,
     *   mutation?: unknown,
     *   execution?: unknown,
     *   previousAttempt?: unknown,
     *   exports?: Array<string | { name: string }>
     * }} input
     */
    async proposeTest(input) {
      const exports =
        Array.isArray(input?.exports) && input.exports.length > 0
          ? input.exports
          : deriveExportNames(input?.source ?? "");

      if (exports.length === 0) {
        throw new ProposalError(
          "The source does not expose a named exported function the proposal can target.",
          { field: "exportName" },
        );
      }

      const prompt = buildPrompt({
        requirement: input?.requirement,
        source: input?.source,
        tests: input?.tests,
        mutation: input?.mutation,
        execution: input?.execution,
        previousAttempt: input?.previousAttempt,
        exports,
      });

      const body = {
        model: id,
        temperature: 0,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      };
      if (positiveNumber(model.maxTokens, 0) > 0) body.max_tokens = Math.floor(Number(model.maxTokens));
      if (includeResponseFormat) body.response_format = { type: "json_object" };

      const payload = await request(body);
      const content = decodeContent(payload);
      const decoded = extractJson(content);

      if (decoded === null) {
        throw new ProposalError(
          "The model response did not contain a JSON object. Return exactly one JSON object with title, exportName, args, expected and rationale.",
          { field: "response" },
        );
      }

      return validateProposal(decoded, { exports, maxArgsBytes });
    },

    describe() {
      return { driver: "openai-compatible", id };
    },
  };
}

export { ProposalError, ModelError, validateProposal, renderProposal };
export { buildPrompt, extractJson } from "./prompt.js";
export default createModel;
