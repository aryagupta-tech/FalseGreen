/**
 * Normalizes Vitest's JSON reporter output and reads assertion failures.
 * Everything here is pure: no filesystem, no process, no framework imports.
 */

const DEFAULT_MAX_OUTPUT_BYTES = 65536;

const EMPTY_SUITE_RE =
  /(?:No test suite found|No test files found|No tests found|Test Files\s+no tests)/i;

const TEST_TIMEOUT_RE =
  /(?:(?:test|hook)\s+timed out|timed out in \d+\s*ms|Timeout of \d+\s*ms exceeded)/i;

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * @param {unknown} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateOutput(text, maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  const value = typeof text === "string" ? text : text == null ? "" : String(text);
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  if (limit === 0) return "";

  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= limit) return value;

  const marker = `\n...[truncated ${buffer.byteLength - limit} bytes]...\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= limit) {
    return safeSlice(buffer, 0, limit);
  }

  const budget = limit - markerBytes;
  const headBytes = Math.floor(budget * 0.4);
  const tailBytes = budget - headBytes;
  const output =
    safeSlice(buffer, 0, headBytes) +
    marker +
    safeSlice(buffer, buffer.byteLength - tailBytes, buffer.byteLength);

  if (Buffer.byteLength(output, "utf8") <= limit) return output;
  let clipped = Buffer.from(output, "utf8").subarray(0, limit).toString("utf8");
  while (Buffer.byteLength(clipped, "utf8") > limit) {
    clipped = clipped.slice(0, -1);
  }
  return clipped;
}

/**
 * Decode a byte range without allowing invalid UTF-8 to balloon past the limit.
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 */
function safeSlice(buffer, start, end) {
  return buffer.subarray(Math.max(0, start), Math.max(0, end)).toString("utf8");
}

/**
 * @param {unknown} status
 * @returns {"passed" | "failed" | "skipped"}
 */
function mapStatus(status) {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  return "skipped";
}

/**
 * @param {Record<string, unknown>} assertion
 * @returns {string[]}
 */
function failureMessages(assertion) {
  const messages = [];
  const raw = assertion?.failureMessages ?? assertion?.failureMessage;
  if (Array.isArray(raw)) {
    for (const message of raw) {
      if (typeof message === "string" && message.trim()) messages.push(message);
    }
  } else if (typeof raw === "string" && raw.trim()) {
    messages.push(raw);
  }
  return messages;
}

/**
 * @param {unknown} json
 * @param {{ durationMs?: number, exitCode?: number | null, stdout?: string, stderr?: string, maxOutputBytes?: number }} [meta]
 */
export function normalizeVitestJson(
  json,
  { durationMs = 0, exitCode = null, stdout = "", stderr = "", maxOutputBytes } = {},
) {
  const limit =
    Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
      ? Math.floor(maxOutputBytes)
      : DEFAULT_MAX_OUTPUT_BYTES;

  /** @type {{ stdout: string, stderr: string }} */
  const logs = {
    stdout: truncateOutput(stdout, limit),
    stderr: truncateOutput(stderr, limit),
  };

  const tests = [];
  const fileErrors = [];

  if (!json || typeof json !== "object" || !Array.isArray(json.testResults)) {
    return {
      outcome: "error",
      counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
      tests: [],
      durationMs: nonNegativeInt(durationMs),
      exitCode: typeof exitCode === "number" ? exitCode : null,
      error: "Vitest did not produce a JSON report.",
      logs,
    };
  }

  for (const file of json.testResults) {
    if (!file || typeof file !== "object") continue;
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    for (const assertion of assertions) {
      if (!assertion || typeof assertion !== "object") continue;
      const title =
        typeof assertion.fullName === "string" && assertion.fullName.trim()
          ? assertion.fullName
          : typeof assertion.title === "string" && assertion.title.trim()
            ? assertion.title
            : "unnamed test";
      tests.push({
        name: title,
        status: mapStatus(assertion.status),
        failureMessages: failureMessages(assertion),
      });
    }
    if (assertions.length === 0) {
      const message = typeof file.message === "string" ? file.message.trim() : "";
      if (message) fileErrors.push(message);
    }
  }

  const counts = { total: tests.length, passed: 0, failed: 0, skipped: 0 };
  for (const test of tests) counts[test.status] += 1;

  const onlyEmptySuiteMessages =
    fileErrors.length > 0 && fileErrors.every((message) => EMPTY_SUITE_RE.test(message));
  const suiteErrors = fileErrors.filter((message) => !EMPTY_SUITE_RE.test(message));
  const emptyFromStderr = tests.length === 0 && EMPTY_SUITE_RE.test(stderr);

  let outcome = "completed";
  let error = null;

  if (counts.failed > 0) {
    outcome = "completed";
  } else if (suiteErrors.length > 0) {
    outcome = "error";
    error = suiteErrors.join("\n\n");
  } else if (counts.total === 0) {
    if (onlyEmptySuiteMessages || emptyFromStderr) {
      outcome = "completed";
    } else if (json.success === false) {
      outcome = "error";
      error = fileErrors[0] || stderr.trim() || "Vitest reported no test results.";
    }
  }

  return {
    outcome,
    counts,
    tests,
    durationMs: nonNegativeInt(durationMs),
    exitCode: typeof exitCode === "number" ? exitCode : null,
    error,
    logs,
  };
}

/**
 * True when a normalized result failed because a test or hook was killed by
 * Vitest's own timeout, rather than because an assertion failed.
 * @param {{ tests?: Array<{ failureMessages?: string[] }> }} result
 */
export function hasTestTimeout(result) {
  const tests = Array.isArray(result?.tests) ? result.tests : [];
  return tests.some((test) =>
    (Array.isArray(test?.failureMessages) ? test.failureMessages : []).some((message) =>
      TEST_TIMEOUT_RE.test(message),
    ),
  );
}

/**
 * Extract the actual and expected operands from a Vitest assertion message.
 *
 * Understands:
 *   AssertionError: expected 99 to be 0
 *   AssertionError: expected { a: 1 } to deeply equal { a: 2 }
 *
 * @param {unknown} message
 * @returns {{ kind: "assertion" | "error", actual?: unknown, expected?: unknown } | null}
 */
export function parseVitestFailure(message) {
  if (typeof message !== "string" || message.trim() === "") return null;
  const text = message.replace(ANSI_RE, "");

  for (const line of text.split(/\r?\n/)) {
    const deeplyEqual = line.match(
      /expected\s+(.+?)\s+to\s+deeply\s+equal\s+(.+?)(?:\s+\/\/.*)?$/,
    );
    if (deeplyEqual) {
      return {
        kind: "assertion",
        actual: parseLiteral(deeplyEqual[1]),
        expected: parseLiteral(deeplyEqual[2]),
      };
    }

    const toBe = line.match(/expected\s+(.+?)\s+to\s+be\s+(.+?)(?:\s+\/\/.*)?$/);
    if (toBe) {
      return {
        kind: "assertion",
        actual: parseLiteral(toBe[1]),
        expected: parseLiteral(toBe[2]),
      };
    }
  }

  return { kind: "error" };
}

/**
 * Parse the small subset of JavaScript/JSON literal syntax Vitest prints.
 * Anything unrecognized is returned as the trimmed source text.
 * @param {string} raw
 */
function parseLiteral(raw) {
  const value = raw.trim();
  if (value === "") return "";

  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "undefined") return undefined;
  if (value === "NaN") return Number.NaN;
  if (value === "Infinity") return Number.POSITIVE_INFINITY;
  if (value === "-Infinity") return Number.NEGATIVE_INFINITY;

  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    return Number(value);
  }

  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(['\\])/g, "$1");
  }

  if (
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("{") && value.endsWith("}"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

/**
 * @param {unknown} value
 */
function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}
