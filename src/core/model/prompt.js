const MAX_FEEDBACK_CHARS = 8000;
const MAX_FAILURE_CHARS = 600;

function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function truncate(value, limit) {
  const source = text(value);
  if (source.length <= limit) return source;
  return `${source.slice(0, limit)}\n[truncated]`;
}

function safeJson(value, fallback = "null") {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

/**
 * A compact, deterministic view of an ExecutionResult. The model needs the
 * failure evidence, not the full logs.
 *
 * @param {unknown} execution
 * @returns {Record<string, unknown> | null}
 */
export function summarizeExecution(execution) {
  if (execution === null || typeof execution !== "object") return null;
  const record = /** @type {Record<string, any>} */ (execution);

  if (record.outcome === undefined && ("baseline" in record || "mutant" in record)) {
    return {
      baseline: summarizeExecution(record.baseline),
      mutant: summarizeMutantEvidence(record.mutant),
    };
  }

  const tests = Array.isArray(record.tests)
    ? record.tests.map((test) => {
        const row = test && typeof test === "object" ? test : {};
        const messages = Array.isArray(row.failureMessages)
          ? row.failureMessages
          : typeof row.failureMessage === "string"
            ? [row.failureMessage]
            : [];
        return {
          name: text(row.name),
          status: text(row.status),
          failureMessages: messages.slice(0, 3).map((message) => truncate(message, MAX_FAILURE_CHARS)),
        };
      })
    : [];

  return {
    outcome: text(record.outcome),
    counts: {
      total: Number(record.counts?.total ?? 0),
      passed: Number(record.counts?.passed ?? 0),
      failed: Number(record.counts?.failed ?? 0),
      skipped: Number(record.counts?.skipped ?? 0),
    },
    tests,
    durationMs: Number(record.durationMs ?? 0),
    error: record.error == null ? null : truncate(record.error, MAX_FAILURE_CHARS),
  };
}

function summarizeMutantEvidence(evidence) {
  if (evidence === null || typeof evidence !== "object") return null;
  const record = /** @type {Record<string, any>} */ (evidence);
  if (record.outcome !== undefined) return summarizeExecution(record);
  return {
    id: text(record.id),
    change: text(record.change),
    status: text(record.status),
    counts: record.counts
      ? {
          total: Number(record.counts.total ?? 0),
          passed: Number(record.counts.passed ?? 0),
          failed: Number(record.counts.failed ?? 0),
          skipped: Number(record.counts.skipped ?? 0),
        }
      : null,
    durationMs: Number(record.durationMs ?? 0),
    reason: record.reason == null ? null : truncate(record.reason, MAX_FAILURE_CHARS),
  };
}

/**
 * A compact, deterministic view of a mutation. Full before/after sources are
 * already supplied separately and are not repeated here.
 *
 * @param {unknown} mutation
 * @returns {Record<string, unknown> | null}
 */
export function summarizeMutation(mutation) {
  if (mutation === null || typeof mutation !== "object") return null;
  const record = /** @type {Record<string, any>} */ (mutation);
  return {
    id: text(record.id),
    family: text(record.family),
    operator: text(record.operator),
    replacement: text(record.replacement),
    line: Number(record.line ?? 0),
    column: Number(record.column ?? 0),
    change: text(record.change),
  };
}

/**
 * Turn any previous-attempt value into deterministic feedback text. Accepts a
 * plain string, the job layer's attempt record, or a ProposalError.
 *
 * @param {unknown} previousAttempt
 * @returns {string}
 */
export function previousAttemptFeedback(previousAttempt) {
  if (previousAttempt === null || previousAttempt === undefined) return "";
  let value = previousAttempt;

  if (typeof value === "string") return truncate(value.trim(), MAX_FEEDBACK_CHARS);

  if (value instanceof Error) {
    value = {
      error: text(value.message),
      name: text(value.name),
      code: text(/** @type {any} */ (value).code),
    };
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = /** @type {Record<string, any>} */ (value);
    if (typeof record.message === "string" && record.error === undefined) {
      value = {
        error: record.message,
        proposal: record.proposal ?? null,
        matrix: record.matrix ?? null,
        mismatch: record.mismatch ?? null,
      };
    }
  }

  const serialized = safeJson(value, text(value));
  return truncate(serialized.trim(), MAX_FEEDBACK_CHARS);
}

export const SYSTEM_PROMPT = `You write one regression test for a JavaScript module. The stated requirement is the only source of intended behaviour. Never infer intended behaviour from the implementation, and never justify an expectation with what the code currently does.

A mutation makes a small change to the implementation. The existing tests still pass, so they cannot tell the original and the mutated versions apart. Choose one concrete input, derived from the requirement, whose expected result distinguishes the two versions.

Output data only. Return exactly one JSON object with exactly these keys and no others:
- "title": string, 3 to 120 characters, describing the behaviour being checked.
- "exportName": string, exactly one of the exported function names supplied in the user message.
- "args": JSON array of positional arguments to call that function with, at most 8 items.
- "expected": the exact JSON value the requirement says the function must return for those arguments.
- "rationale": string, at most 500 characters, explaining how the requirement yields this expectation.

Rules: do not return code, test source, imports, mocks, comments or markdown fences. Do not add fields such as code, mocks, steps or explanation. Do not use undefined, functions or non-JSON values. If feedback about a rejected previous attempt is included, fix the specific problem and do not repeat it.`;

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
 * @returns {{ system: string, user: string }}
 */
export function buildPrompt(input) {
  const exports = Array.isArray(input.exports)
    ? input.exports
        .map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? item.name : null))
        .filter((name) => typeof name === "string" && name.length > 0)
    : [];

  const feedback = previousAttemptFeedback(input.previousAttempt);
  const sections = [
    "REQUIREMENT (the only source of intended behaviour):",
    text(input.requirement),
    "",
    "SOURCE UNDER TEST (context only; do not infer the requirement from it):",
    text(input.source),
    "",
    "EXISTING TESTS (they pass against both versions and miss the mutation):",
    text(input.tests),
    "",
    "SURVIVING MUTATION:",
    safeJson(summarizeMutation(input.mutation)),
    "",
    "EXECUTION EVIDENCE (the mutant passed the existing tests):",
    safeJson(summarizeExecution(input.execution)),
    "",
    "EXPORTED FUNCTIONS:",
    exports.length > 0 ? exports.join(", ") : "(none detected)",
  ];

  if (feedback) {
    sections.push(
      "",
      "PREVIOUS ATTEMPT WAS REJECTED. Correct this specific problem:",
      feedback,
      "",
      "Do not repeat the rejected proposal. Return a corrected JSON object only.",
    );
  }

  sections.push(
    "",
    "Return the JSON object only. It must have exactly the keys title, exportName, args, expected, rationale.",
  );

  return { system: SYSTEM_PROMPT, user: sections.join("\n") };
}

/**
 * Tolerate a fenced or lightly wrapped JSON object while refusing non-object
 * payloads. The caller still validates the object strictly.
 *
 * @param {string} content
 * @returns {unknown}
 */
export function extractJson(content) {
  const input = text(content).trim();
  if (!input) return null;

  const direct = tryParse(input);
  if (direct.ok) return direct.value;

  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fencePattern.exec(input)) !== null) {
    const parsed = tryParse(fenceMatch[1].trim());
    if (parsed.ok) return parsed.value;
  }

  let searchFrom = 0;
  while (searchFrom < input.length) {
    const start = input.indexOf("{", searchFrom);
    if (start === -1) break;
    const candidate = balancedObject(input, start);
    if (candidate) {
      const parsed = tryParse(candidate);
      if (parsed.ok) return parsed.value;
    }
    searchFrom = start + 1;
  }

  return null;
}

function tryParse(value) {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * @param {string} source
 * @param {number} start
 * @returns {string | null}
 */
function balancedObject(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * @param {string} content
 * @returns {string}
 */
export function extractMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

export { truncate, text, safeJson };
