import { Sandbox } from "@vercel/sandbox";

import { ConfigError } from "../errors.js";
import {
  hasTestTimeout,
  normalizeVitestJson,
} from "./vitest-results.js";

const RUN_DIR = "/tmp/falsegreen/run";
const RESULTS_PATH = `${RUN_DIR}/results.json`;
const VITEST_PATH = "/opt/falsegreen/node_modules/vitest/vitest.mjs";
const DEFAULT_MAX_OUTPUT_BYTES = 65536;
const DEFAULT_TEST_TIMEOUT_MS = 10000;

/**
 * @typedef {import("./index.js").RunnerConfig} RunnerConfig
 * @typedef {{ 'source.js'?: string, 'source.test.js'?: string }} RunFiles
 */

/**
 * Build a runner that executes a submitted suite inside a Vercel Sandbox. The
 * snapshot is expected to contain Node 24 and Vitest at `/opt/falsegreen`.
 *
 * @param {RunnerConfig} config
 * @param {{ createSandbox?: (params: Record<string, unknown>) => Promise<any> }} [deps]
 */
export function createSandboxRunner(config, deps = {}) {
  const snapshotId = config?.execution?.sandboxSnapshotId?.trim?.() || "";
  if (!snapshotId) {
    throw new ConfigError(
      "Sandbox execution requires VERCEL_SANDBOX_SNAPSHOT_ID pointing at a snapshot with Node and Vitest installed. Run `node scripts/build-sandbox-snapshot.mjs` to build one.",
    );
  }

  const createSandbox = deps.createSandbox ?? ((params) => Sandbox.create(params));
  const maxOutputBytes =
    positiveInt(config?.limits?.maxOutputBytes) ?? DEFAULT_MAX_OUTPUT_BYTES;
  const defaultTimeoutMs =
    positiveInt(config?.limits?.testTimeoutMs) ?? DEFAULT_TEST_TIMEOUT_MS;

  return {
    driver: "sandbox",

    /**
     * @param {{ files: RunFiles, timeoutMs?: number, signal?: AbortSignal }} input
     */
    async runTests({ files, timeoutMs, signal } = {}) {
      const effectiveTimeoutMs = positiveInt(timeoutMs) ?? defaultTimeoutMs;
      const startedAt = Date.now();
      /** @type {any} */
      let sandbox = null;

      try {
        sandbox = await createSandbox({
          source: { type: "snapshot", snapshotId },
          networkPolicy: "deny-all",
          ports: [],
          timeout: Math.max(60000, effectiveTimeoutMs + 30000),
        });

        if (typeof sandbox.fs?.mkdir === "function") {
          await sandbox.fs.mkdir(RUN_DIR, { recursive: true, signal });
        }

        const source = typeof files?.["source.js"] === "string" ? files["source.js"] : "";
        const tests =
          typeof files?.["source.test.js"] === "string" ? files["source.test.js"] : "";

        await sandbox.writeFiles(
          [
            { path: `${RUN_DIR}/package.json`, content: '{"type":"module"}\n' },
            { path: `${RUN_DIR}/vitest.config.mjs`, content: vitestConfig(effectiveTimeoutMs) },
            { path: `${RUN_DIR}/source.js`, content: source },
            { path: `${RUN_DIR}/source.test.js`, content: tests },
          ],
          { signal },
        );

        let command;
        try {
          command = await sandbox.runCommand({
            cmd: "node",
            args: [
              VITEST_PATH,
              "run",
              "--config",
              "vitest.config.mjs",
              "--reporter=json",
              "--outputFile=results.json",
              "--no-color",
            ],
            cwd: RUN_DIR,
            timeoutMs: effectiveTimeoutMs,
            signal,
          });
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          if (signal?.aborted) {
            return timeoutResult({
              durationMs,
              error: "Run aborted.",
            });
          }
          if (looksLikeTimeout(error, Date.now() - startedAt, effectiveTimeoutMs)) {
            return timeoutResult({
              durationMs,
              error: `Test run exceeded ${effectiveTimeoutMs}ms and was killed.`,
            });
          }
          return errorResult(
            `Sandbox command failed: ${error instanceof Error ? error.message : String(error)}`,
            { durationMs },
          );
        }

        const stdout = await commandOutput(command, "stdout");
        const stderr = await commandOutput(command, "stderr");
        const durationMs = Date.now() - startedAt;
        const exitCode = typeof command.exitCode === "number" ? command.exitCode : null;

        const raw = await readResultsFile(sandbox);
        let parsed = null;
        let parseError = null;
        if (raw !== null) {
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            parseError = error;
          }
        }

        const result = normalizeVitestJson(parsed, {
          durationMs,
          exitCode,
          stdout,
          stderr,
          maxOutputBytes,
        });

        if (signal?.aborted) {
          result.outcome = "timeout";
          result.error = "Run aborted.";
          return result;
        }

        if (
          parsed === null &&
          (looksLikeTimeoutText(stderr) ||
            exitCode === 137 ||
            exitCode === 124 ||
            (exitCode !== 0 && durationMs >= effectiveTimeoutMs))
        ) {
          result.outcome = "timeout";
          result.error = `Test run exceeded ${effectiveTimeoutMs}ms and was killed.`;
          return result;
        }

        if (hasTestTimeout(result)) {
          result.outcome = "timeout";
          result.error = `Test exceeded the ${effectiveTimeoutMs}ms timeout.`;
          return result;
        }

        if (parsed === null) {
          result.outcome = "error";
          result.error =
            (parseError ? `Could not read the Vitest JSON report: ${parseError.message}. ` : "") +
            (stderr.trim() || stdout.trim() || "Vitest did not write a results file.");
          return result;
        }

        return result;
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        return errorResult(
          `Sandbox execution failed: ${error instanceof Error ? error.message : String(error)}`,
          { durationMs: Date.now() - startedAt },
        );
      } finally {
        if (sandbox) {
          await sandbox.stop().catch(() => {});
        }
      }
    },
  };
}

/**
 * @param {any} sandbox
 * @returns {Promise<string | null>}
 */
async function readResultsFile(sandbox) {
  try {
    if (sandbox.fs && typeof sandbox.fs.readFile === "function") {
      return await sandbox.fs.readFile(RESULTS_PATH, "utf8");
    }
  } catch {
  }

  try {
    const cat = await sandbox.runCommand({
      cmd: "cat",
      args: [RESULTS_PATH],
      timeoutMs: 10000,
    });
    if (cat && cat.exitCode === 0) {
      return await commandOutput(cat, "stdout");
    }
  } catch {
  }
  return null;
}

/**
 * @param {any} command
 * @param {"stdout" | "stderr"} stream
 */
async function commandOutput(command, stream) {
  try {
    if (typeof command?.[stream] === "function") {
      const value = await command[stream]();
      return typeof value === "string" ? value : "";
    }
    if (typeof command?.[stream] === "string") return command[stream];
  } catch {
    return "";
  }
  return "";
}

/**
 * @param {unknown} error
 * @param {number} elapsedMs
 * @param {number} timeoutMs
 */
function looksLikeTimeout(error, elapsedMs, timeoutMs) {
  const message = error instanceof Error ? error.message : String(error);
  return looksLikeTimeoutText(message) || elapsedMs >= timeoutMs;
}

/**
 * @param {string} text
 */
function looksLikeTimeoutText(text) {
  return /\b(timed out|timeout|SIGKILL|killed|deadline exceeded)\b/i.test(text);
}

/**
 * @param {number} timeoutMs
 */
function vitestConfig(timeoutMs) {
  return `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: ["source.test.js"],
    testTimeout: ${timeoutMs},
    hookTimeout: ${timeoutMs},
    fileParallelism: false,
  },
});
`;
}

/**
 * @param {{ durationMs: number, error: string }} input
 */
function timeoutResult({ durationMs, error }) {
  return {
    outcome: "timeout",
    counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
    tests: [],
    durationMs,
    exitCode: null,
    error,
    logs: { stdout: "", stderr: "" },
  };
}

/**
 * @param {string} message
 * @param {{ durationMs: number }} input
 */
function errorResult(message, { durationMs }) {
  return {
    outcome: "error",
    counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
    tests: [],
    durationMs,
    exitCode: null,
    error: message,
    logs: { stdout: "", stderr: "" },
  };
}

/**
 * @param {unknown} value
 */
function positiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}
