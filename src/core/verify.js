import { sanitizeTitle } from "./model/render.js";
import { applyMutation } from "./mutations.js";

const ROWS = Object.freeze([
  { id: "original-existing", label: "Original + existing tests", expected: "pass", code: "original" },
  { id: "mutant-existing", label: "Mutant + existing tests", expected: "pass", code: "mutant" },
  { id: "original-proposed", label: "Original + proposed test", expected: "pass", code: "original" },
  { id: "mutant-proposed", label: "Mutant + proposed test", expected: "fail-proposed", code: "mutant" },
]);

function messageList(test) {
  if (!test || typeof test !== "object") return [];
  if (Array.isArray(test.failureMessages)) {
    return test.failureMessages.filter((message) => typeof message === "string" && message.trim().length > 0);
  }
  if (typeof test.failureMessage === "string" && test.failureMessage.trim().length > 0) {
    return [test.failureMessage];
  }
  return [];
}

function firstFailure(result) {
  for (const test of result?.tests ?? []) {
    if (test?.status !== "failed") continue;
    const messages = messageList(test);
    if (messages.length > 0) return messages[0];
    return `Test ${JSON.stringify(String(test?.name ?? "unknown"))} failed.`;
  }
  const failed = Number(result?.counts?.failed ?? 0);
  return failed > 0 ? `${failed} test${failed === 1 ? "" : "s"} failed.` : null;
}

function classify(result) {
  if (result === null || typeof result !== "object") {
    return { observed: "error", detail: "Execution returned no result." };
  }
  if (result.outcome === "timeout") {
    return { observed: "timeout", detail: typeof result.error === "string" && result.error ? result.error : "Execution timed out." };
  }
  if (result.outcome === "error") {
    return {
      observed: "error",
      detail: typeof result.error === "string" && result.error ? result.error : "Execution failed.",
    };
  }
  if (result.outcome === "completed") {
    const counted = Number(result.counts?.failed);
    const failed = Number.isFinite(counted)
      ? counted
      : (Array.isArray(result.tests) ? result.tests : []).filter((test) => test?.status === "failed").length;
    if (failed > 0) {
      return { observed: "fail", detail: firstFailure(result) };
    }
    return { observed: "pass", detail: null };
  }
  return {
    observed: "error",
    detail: `Unexpected execution outcome ${JSON.stringify(result.outcome ?? null)}.`,
  };
}

/**
 * @param {unknown} mutation
 * @param {string} source
 * @returns {string}
 */
function applyMutationLocally(mutation, source) {
  const record = mutation && typeof mutation === "object" ? /** @type {Record<string, any>} */ (mutation) : null;
  const start = record?.start;
  const end = record?.end;
  const replacement = record?.replacement;

  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start &&
    end <= source.length &&
    typeof replacement === "string"
  ) {
    return applyMutation(source, record);
  }
  if (typeof record?.after === "string") return record.after;
  throw new Error("The mutation cannot be applied to the source.");
}

function findGeneratedTest(result, testName) {
  const tests = Array.isArray(result?.tests) ? result.tests : [];
  const named = tests.filter((test) => test && typeof test.name === "string");
  return (
    named.find((test) => test.name === testName) ??
    named.find((test) => test.name.trim() === testName) ??
    named.find((test) => test.name.endsWith(testName)) ??
    null
  );
}

function assertionLike(message) {
  const text = String(message ?? "");
  if (/\bAssertionError\b/.test(text)) return true;
  return /\bexpected\b[\s\S]{0,300}?\bto\s+(?:be|equal|deeply equal|strictly equal|loosely equal|match|contain|include|throw|have)\b/i.test(
    text,
  );
}

function generatedOutcome(result, testName) {
  const test = findGeneratedTest(result, testName);
  if (!test) {
    return { found: false, test: null, status: null, assertion: false, messages: [], observed: "different value" };
  }
  const messages = messageList(test);
  const assertion = test.status === "failed" && assertionLike(messages.join("\n"));
  return {
    found: true,
    test,
    status: test.status ?? null,
    assertion,
    messages,
    observed: parseObservedValue(messages.join("\n")),
  };
}

/**
 * Read the actual value out of a Vitest assertion message such as
 * `AssertionError: expected 99 to be 0`. Falls back to `different value`.
 *
 * @param {string} message
 * @returns {unknown}
 */
export function parseObservedValue(message) {
  const firstLine = String(message ?? "").split(/\r?\n/, 1)[0] ?? "";
  const match =
    /\bexpected\s+(.+?)\s+to\s+(?:be|equal|deeply equal|strictly equal|loosely equal|match|contain|include|throw|have)\b/i.exec(
      firstLine,
    ) ?? /\bexpected\s+(.+?)\s+but\s+(?:received|got)\b/i.exec(firstLine);
  if (!match) return "different value";
  return coerceToken(match[1].trim());
}

function coerceToken(token) {
  if (token === "undefined") return "undefined";
  if (token === "NaN") return "NaN";
  if (token === "Infinity") return "Infinity";
  if (token === "-Infinity") return "-Infinity";
  if (token === "null") return null;
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "+0") return 0;
  if (token === "-0") return -0;

  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    try {
      return JSON.parse(token);
    } catch {
      return "different value";
    }
  }
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
    return Number(token);
  }
  if ((token.startsWith("{") && token.endsWith("}")) || (token.startsWith("[") && token.endsWith("]"))) {
    try {
      return JSON.parse(token);
    } catch {
      return "different value";
    }
  }
  return "different value";
}

function rowPassed(expected, observed) {
  if (expected === "pass") return observed === "pass";
  if (expected === "fail-proposed") return observed === "fail";
  return false;
}

function matrixRow(spec, result) {
  const classified = classify(result);
  return {
    id: spec.id,
    label: spec.label,
    expected: spec.expected,
    observed: classified.observed,
    status: rowPassed(spec.expected, classified.observed) ? "pass" : "fail",
    durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : 0,
    detail: classified.detail,
  };
}

function errorMatrix(detail) {
  return ROWS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    expected: spec.expected,
    observed: "error",
    status: "fail",
    durationMs: 0,
    detail,
  }));
}

/**
 * Run the four-cell verification matrix exactly once, sequentially, and decide
 * whether the proposed regression test is a verified repair.
 *
 * @param {{
 *   proposal: { title?: string, args?: unknown[], expected?: unknown },
 *   generatedTest: string,
 *   run: (options: { files: Record<string, string>, timeoutMs: number, signal?: AbortSignal }) => Promise<any>,
 *   source: string,
 *   tests: string,
 *   mutation: unknown,
 *   requirement?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal
 * }} input
 * @returns {Promise<{
 *   status: 'verified'|'mismatch'|'rejected'|'error',
 *   matrix: Array<{ id: string, label: string, expected: string, observed: string, status: string, durationMs: number, detail: string|null }>,
 *   mismatch: { requirement: string, args: unknown[], expected: unknown, observed: unknown, message: string }|null,
 *   detail: string|null
 * }>}
 */
export async function verifyRepair(input) {
  const {
    proposal,
    generatedTest,
    run,
    source,
    tests,
    mutation,
    requirement,
  } = input ?? {};

  if (typeof run !== "function") {
    return {
      status: "error",
      matrix: errorMatrix("No execution function was provided."),
      mismatch: null,
      detail: "No execution function was provided.",
    };
  }

  let mutantSource;
  try {
    mutantSource = applyMutationLocally(mutation, String(source ?? ""));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The mutation cannot be applied.";
    return { status: "error", matrix: errorMatrix(detail), mismatch: null, detail };
  }

  const requestedTimeout = Number(input.timeoutMs);
  const hasTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0;
  const timeoutMs = hasTimeout ? requestedTimeout : undefined;
  const signal = input.signal;
  const testName = sanitizeTitle(proposal?.title ?? "");
  const results = [];

  const runRow = async (spec) => {
    const files = {
      "source.js": spec.code === "mutant" ? mutantSource : String(source ?? ""),
      "source.test.js": String(tests ?? ""),
    };
    if (spec.id.endsWith("-proposed")) {
      const generated = String(generatedTest ?? "");
      files["source.test.js"] = `${String(tests ?? "")}\n${generated}`;
      files["source.regression.test.js"] = generated;
    }

    const options = { files };
    if (hasTimeout) options.timeoutMs = timeoutMs;
    if (signal !== undefined) options.signal = signal;

    try {
      const result = await run(options);
      results.push(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        outcome: "error",
        counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
        tests: [],
        durationMs: 0,
        exitCode: null,
        error: `Execution threw: ${message}`,
        logs: { stdout: "", stderr: "" },
      };
      results.push(result);
      return result;
    }
  };

  const matrix = [];
  for (const spec of ROWS) {
    const result = await runRow(spec);
    matrix.push(matrixRow(spec, result));
  }

  const originalExisting = matrix[0];
  const mutantExisting = matrix[1];
  const originalProposed = matrix[2];
  const mutantProposed = matrix[3];
  const originalGenerated = generatedOutcome(results[2], testName);
  const mutantGenerated = generatedOutcome(results[3], testName);

  if (originalExisting.observed !== "pass") {
    const detail = "The original implementation does not pass the existing tests.";
    return { status: "error", matrix, mismatch: null, detail };
  }

  if (mutantExisting.observed !== "pass") {
    const detail =
      "The mutant does not pass the existing tests, so it cannot be a missed mutation with a verifiable repair.";
    return { status: "error", matrix, mismatch: null, detail };
  }

  if (originalProposed.observed === "timeout" || originalProposed.observed === "error") {
    return {
      status: "error",
      matrix,
      mismatch: null,
      detail: `The proposed run did not complete against the original implementation (${originalProposed.observed}).`,
    };
  }

  if (originalGenerated.assertion) {
    // Keep the assertion line; stack frames are noise in the verdict.
    const message = String(originalGenerated.messages[0] ?? "")
      .split(/\r?\n/)[0]
      .trim();
    return {
      status: "mismatch",
      matrix,
      mismatch: {
        requirement: String(requirement ?? ""),
        args: Array.isArray(proposal?.args) ? proposal.args : [],
        expected: proposal?.expected,
        observed: originalGenerated.observed,
        message,
      },
      detail:
        "The proposed test fails against the original implementation. The requirement and the implementation disagree.",
    };
  }

  if (originalProposed.observed !== "pass") {
    return {
      status: "error",
      matrix,
      mismatch: null,
      detail:
        originalProposed.observed === "fail"
          ? "The proposed test failed against the original implementation without an assertion failure on the generated test."
          : `The proposed run did not complete against the original implementation (${originalProposed.observed}).`,
    };
  }

  if (mutantProposed.observed === "timeout" || mutantProposed.observed === "error") {
    return {
      status: "error",
      matrix,
      mismatch: null,
      detail: `The mutant run did not complete (${mutantProposed.observed}).`,
    };
  }

  if (mutantGenerated.found && mutantGenerated.status === "passed") {
    return {
      status: "rejected",
      matrix,
      mismatch: null,
      detail: "The mutant still passes the proposed test, so it does not catch the missed behaviour.",
    };
  }

  if (!mutantGenerated.found) {
    return {
      status: "error",
      matrix,
      mismatch: null,
      detail: "The generated test did not run against the mutant.",
    };
  }

  if (mutantGenerated.assertion) {
    return { status: "verified", matrix, mismatch: null, detail: null };
  }

  return {
    status: "error",
    matrix,
    mismatch: null,
    detail:
      mutantProposed.observed === "fail"
        ? "The mutant run failed without an assertion failure on the generated test."
        : `The mutant run did not complete (${mutantProposed.observed}).`,
  };
}

export default verifyRepair;
