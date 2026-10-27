import { AppError, ValidationError, errorBody } from "../core/errors.js";

/** Maximum accepted JSON request body, in bytes. */
export const MAX_JSON_BYTES = 256 * 1024;

function isJsonMediaType(value) {
  const mediaType = String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function payloadTooLarge(maxBytes) {
  return new AppError(
    "payload_too_large",
    `Request body must be at most ${maxBytes} bytes.`,
    413,
  );
}

function unsupportedMediaType() {
  return new AppError(
    "unsupported_media_type",
    "Send a JSON body with Content-Type: application/json.",
    415,
  );
}

async function readBodyText(request, maxBytes) {
  const body = request.body;
  if (!body || typeof body.getReader !== "function") {
    const text = typeof request.text === "function" ? await request.text() : "";
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw payloadTooLarge(maxBytes);
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The stream is already unusable; the size error is the useful one.
      }
      throw payloadTooLarge(maxBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Read and parse a JSON object from a Request, enforcing the byte limit.
 * Throws AppError subclasses with a safe, user-facing message.
 *
 * @param {Request} request
 * @param {number} [maxBytes]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(request, maxBytes = MAX_JSON_BYTES) {
  if (!request || typeof request.headers?.get !== "function") {
    throw new ValidationError("A request body is required.", { field: "body" });
  }

  const limit =
    Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_JSON_BYTES;

  const contentType = request.headers.get("content-type");
  if (!isJsonMediaType(contentType)) throw unsupportedMediaType();

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw payloadTooLarge(limit);
  }

  const text = await readBodyText(request, limit);
  if (text.trim() === "") {
    throw new ValidationError("Send a JSON object.", { field: "body" });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("Send a valid JSON body.", { field: "body" });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("Send a JSON object.", { field: "body" });
  }

  return parsed;
}

/**
 * Build a JSON Response. Every API response is uncacheable.
 *
 * @param {unknown} data
 * @param {number} [status]
 * @returns {Response}
 */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Translate an error into the contract error envelope.
 *
 * @param {unknown} error
 * @returns {Response}
 */
export function errorResponse(error) {
  const { status, body } = errorBody(error);
  return json(body, status);
}

/**
 * Wrap a route handler so thrown AppErrors become safe JSON responses and
 * every response is marked no-store.
 *
 * @template {(request: Request, context: any) => Promise<Response>} Fn
 * @param {Fn} fn
 * @returns {(request: Request, context: any) => Promise<Response>}
 */
export function handleApi(fn) {
  return async function handleApiRequest(request, context) {
    try {
      const response = await fn(request, context);
      if (
        response instanceof Response &&
        !response.headers.has("cache-control")
      ) {
        response.headers.set("cache-control", "no-store");
      }
      return response;
    } catch (error) {
      if (!(error instanceof AppError)) {
        console.error("[falsegreen] Unhandled API error:", error);
      }
      return errorResponse(error);
    }
  };
}
