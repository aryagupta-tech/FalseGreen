import { AppError } from "../errors.js";

const ALLOWED_KEYS = ["args", "expected", "exportName", "rationale", "title"];
const EXPORT_NAME_PATTERN = /^[A-Za-z_$][\w$]*$/;
const MAX_ARGS = 8;
const MAX_ARGS_BYTES = 4096;
const MAX_RATIONALE_CHARS = 500;
const MIN_TITLE_CHARS = 3;
const MAX_TITLE_CHARS = 120;

/**
 * A model response that passed transport but failed the strict proposal schema.
 * The message is safe to feed back to the model on a retry.
 */
export class ProposalError extends AppError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = undefined) {
    super("invalid_proposal", message, 502, details);
    this.name = "ProposalError";
    this.retryable = true;
  }
}

/**
 * A transport/model-envelope failure. Kept separate from ProposalError so the
 * job layer can tell "the model answered with bad data" from "the call failed".
 */
export class ModelError extends AppError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   * @param {{ retryable?: boolean, cause?: unknown }} [options]
   */
  constructor(message, details = undefined, options = {}) {
    super("model_error", message, 502, details);
    this.name = "ModelError";
    this.retryable = options.retryable !== false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function fail(message, field) {
  throw new ProposalError(message, field ? { field } : undefined);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

const CODE_STRING_PATTERNS = [
  /(?:^|\n)\s*(?:import\s|export\s)/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\b(?:vi|jest)\.(?:mock|hoisted|fn|spyOn|doMock)\b/,
  /\bprocess\.(?:exit|env|binding|mainModule|argv)\b/,
  /\bchild_process\b/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bexpect\s*\(/,
  /\.(?:toBe|toEqual|toStrictEqual|toMatchObject)\s*\(/,
  /<\/?script\b/i,
];

function rejectExecutableStrings(value, field, path = "value") {
  if (typeof value === "string") {
    if (CODE_STRING_PATTERNS.some((pattern) => pattern.test(value))) {
      fail(
        `Proposal.${field} must not contain code or mocks (found executable text at ${path}).`,
        field,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectExecutableStrings(item, field, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      rejectExecutableStrings(item, field, `${path}.${key}`);
    }
  }
}

/**
 * Reject anything that is not representable in JSON: undefined, functions,
 * symbols, BigInt, non-finite numbers, class instances and circular graphs.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @param {number} [depth]
 * @returns {boolean}
 */
function isJsonValue(value, seen = new WeakSet(), depth = 0) {
  if (depth > 32) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (type !== "object") return false;

  const object = /** @type {object} */ (value);
  if (seen.has(object)) return false;
  seen.add(object);

  let valid = true;
  if (Array.isArray(object)) {
    for (const item of object) {
      if (!isJsonValue(item, seen, depth + 1)) {
        valid = false;
        break;
      }
    }
  } else if (!isPlainObject(object)) {
    valid = false;
  } else {
    for (const key of Object.keys(object)) {
      if (!isJsonValue(/** @type {Record<string, unknown>} */ (object)[key], seen, depth + 1)) {
        valid = false;
        break;
      }
    }
  }

  seen.delete(object);
  return valid;
}

/**
 * @param {unknown} exports
 * @returns {string[]}
 */
function exportNames(exports) {
  if (!Array.isArray(exports)) return [];
  const names = [];
  for (const item of exports) {
    if (typeof item === "string") {
      names.push(item);
    } else if (item && typeof item === "object" && typeof item.name === "string") {
      names.push(item.name);
    }
  }
  return names;
}

/**
 * Validate a decoded model proposal against the exact contract shape.
 *
 * @param {unknown} raw
 * @param {{ exports?: Array<string | { name: string }>, maxArgsBytes?: number }} [options]
 * @returns {{ title: string, exportName: string, args: unknown[], expected: unknown, rationale: string }}
 */
export function validateProposal(raw, options = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("Proposal must be a JSON object with title, exportName, args, expected and rationale.", "proposal");
  }

  const record = /** @type {Record<string, unknown>} */ (raw);
  const keys = Object.keys(record);
  const extra = keys.filter((key) => !ALLOWED_KEYS.includes(key)).sort();
  if (extra.length > 0) {
    fail(
      `Proposal contains unsupported key${extra.length === 1 ? "" : "s"} ${extra
        .map((key) => JSON.stringify(key))
        .join(", ")}. Return only title, exportName, args, expected and rationale.`,
      extra[0],
    );
  }

  const missing = ALLOWED_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing.length > 0) {
    fail(
      `Proposal is missing required key${missing.length === 1 ? "" : "s"} ${missing
        .map((key) => JSON.stringify(key))
        .join(", ")}.`,
      missing[0],
    );
  }

  const { title, exportName, args, expected, rationale } = record;

  if (typeof title !== "string") {
    fail("Proposal.title must be a string.", "title");
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle.length < MIN_TITLE_CHARS || title.length > MAX_TITLE_CHARS) {
    fail(
      `Proposal.title must be between ${MIN_TITLE_CHARS} and ${MAX_TITLE_CHARS} characters.`,
      "title",
    );
  }

  if (typeof exportName !== "string") {
    fail("Proposal.exportName must be a string.", "exportName");
  }
  if (!EXPORT_NAME_PATTERN.test(exportName)) {
    fail(
      "Proposal.exportName must be a valid JavaScript identifier such as shippingFee.",
      "exportName",
    );
  }

  const names = exportNames(options.exports);
  if (options.exports !== undefined && names.length === 0) {
    fail("Proposal.exportName must name an exported function; the source exports none.", "exportName");
  }
  if (names.length > 0 && !names.includes(exportName)) {
    fail(
      `Proposal.exportName ${JSON.stringify(exportName)} is not exported. Choose one of: ${names.join(", ")}.`,
      "exportName",
    );
  }

  if (!Array.isArray(args)) {
    fail("Proposal.args must be a JSON array of positional arguments.", "args");
  }
  if (args.length > MAX_ARGS) {
    fail(`Proposal.args must contain at most ${MAX_ARGS} items.`, "args");
  }
  if (!isJsonValue(args)) {
    fail("Proposal.args must contain only JSON values; functions, undefined and cycles are not allowed.", "args");
  }
  const argsBytes = byteLength(JSON.stringify(args));
  const maxArgsBytes = Number.isFinite(options.maxArgsBytes) ? Number(options.maxArgsBytes) : MAX_ARGS_BYTES;
  if (argsBytes > maxArgsBytes) {
    fail(`Proposal.args is ${argsBytes} bytes; the maximum is ${maxArgsBytes} bytes.`, "args");
  }

  if (!isJsonValue(expected)) {
    fail("Proposal.expected must be a JSON value.", "expected");
  }

  rejectExecutableStrings(args, "args");
  rejectExecutableStrings(expected, "expected");

  if (typeof rationale !== "string") {
    fail("Proposal.rationale must be a string.", "rationale");
  }
  if (rationale.length > MAX_RATIONALE_CHARS) {
    fail(`Proposal.rationale must be at most ${MAX_RATIONALE_CHARS} characters.`, "rationale");
  }

  return {
    title,
    exportName,
    args,
    expected,
    rationale,
  };
}

export { EXPORT_NAME_PATTERN, ALLOWED_KEYS };
