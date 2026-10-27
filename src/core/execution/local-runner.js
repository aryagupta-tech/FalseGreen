import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasTestTimeout,
  normalizeVitestJson,
  truncateOutput,
} from "./vitest-results.js";

/** Absolute repo root, derived from this module so any cwd works. */
export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const DEFAULT_MAX_OUTPUT_BYTES = 65536;
const DEFAULT_TEST_TIMEOUT_MS = 10000;

/**
 * @typedef {import("./index.js").RunnerConfig} RunnerConfig
 * @typedef {{ 'source.js'?: string, 'source.test.js'?: string }} RunFiles
 */

/**
 * @param {RunnerConfig} config
 */
export function createLocalRunner(config) {
  const keepArtifacts = Boolean(config?.execution?.keepLocalArtifacts);
  const maxOutputBytes =
    positiveInt(config?.limits?.maxOutputBytes) ?? DEFAULT_MAX_OUTPUT_BYTES;
  const defaultTimeoutMs =
    positiveInt(config?.limits?.testTimeoutMs) ?? DEFAULT_TEST_TIMEOUT_MS;
  const vitestEntry = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
  const nodeModules = path.join(repositoryRoot, "node_modules");

  return {
    driver: "local",

    /**
     * @param {{ files: RunFiles, timeoutMs?: number, signal?: AbortSignal }} input
     */
    async runTests({ files, timeoutMs, signal } = {}) {
      const effectiveTimeoutMs = positiveInt(timeoutMs) ?? defaultTimeoutMs;
      const startedAt = Date.now();
      let dir = null;

      if (signal?.aborted) {
        return abortedResult(startedAt, maxOutputBytes);
      }

      try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "falsegreen-"));
        await writeRunFiles(dir, files, effectiveTimeoutMs);
        await fs.symlink(nodeModules, path.join(dir, "node_modules"), "dir");

        const run = await spawnVitest({
          dir,
          vitestEntry,
          timeoutMs: effectiveTimeoutMs,
          maxOutputBytes,
          signal,
        });

        const durationMs = Date.now() - startedAt;
        let raw = null;
        let readError = null;
        try {
          raw = await fs.readFile(path.join(dir, "results.json"), "utf8");
        } catch (error) {
          readError = error;
        }

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
          exitCode: run.exitCode,
          stdout: run.stdout,
          stderr: run.stderr,
          maxOutputBytes,
        });

        if (run.aborted) {
          result.outcome = "timeout";
          result.error = "Run aborted.";
          return result;
        }

        if (run.timedOut) {
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
          if (run.spawnError) {
            result.error = `Could not start Vitest: ${run.spawnError.message}`;
          } else if (parseError) {
            result.error = `Could not read the Vitest JSON report: ${parseError.message}`;
          } else if (readError) {
            result.error =
              run.stderr.trim() ||
              run.stdout.trim() ||
              "Vitest did not write a results file.";
          } else {
            result.error =
              run.stderr.trim() ||
              run.stdout.trim() ||
              "Vitest did not produce a JSON report.";
          }
          return result;
        }

        return result;
      } catch (error) {
        return {
          outcome: "error",
          counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
          tests: [],
          durationMs: Date.now() - startedAt,
          exitCode: null,
          error: `Local runner failed: ${error instanceof Error ? error.message : String(error)}`,
          logs: { stdout: "", stderr: "" },
        };
      } finally {
        if (dir && !keepArtifacts) {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };
}

/**
 * @param {string} dir
 * @param {RunFiles} files
 * @param {number} timeoutMs
 */
async function writeRunFiles(dir, files, timeoutMs) {
  const source = typeof files?.["source.js"] === "string" ? files["source.js"] : "";
  const tests =
    typeof files?.["source.test.js"] === "string" ? files["source.test.js"] : "";

  await Promise.all([
    fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}\n', "utf8"),
    fs.writeFile(path.join(dir, "vitest.config.mjs"), vitestConfig(timeoutMs), "utf8"),
    fs.writeFile(path.join(dir, "source.js"), source, "utf8"),
    fs.writeFile(path.join(dir, "source.test.js"), tests, "utf8"),
  ]);
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
 * @param {{
 *   dir: string,
 *   vitestEntry: string,
 *   timeoutMs: number,
 *   maxOutputBytes: number,
 *   signal?: AbortSignal,
 * }} input
 */
function spawnVitest({ dir, vitestEntry, timeoutMs, maxOutputBytes, signal }) {
  return new Promise((resolve) => {
    const stdout = createCollector(maxOutputBytes);
    const stderr = createCollector(maxOutputBytes);
    let settled = false;
    let killed = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let exitCode = null;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        timedOut,
        aborted,
        spawnError,
        stdout: stdout.value(),
        stderr: stderr.value(),
      });
    };

    const kill = () => {
      if (killed) return;
      killed = true;
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    };

    const onAbort = () => {
      aborted = true;
      kill();
    };

    let child;
    try {
      child = spawn(
        process.execPath,
        [
          vitestEntry,
          "run",
          "--config",
          "vitest.config.mjs",
          "--reporter=json",
          "--outputFile=results.json",
          "--no-color",
        ],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? process.env.Path ?? "",
            HOME: dir,
            TMPDIR: dir,
            NODE_ENV: "test",
            CI: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error(String(error));
      finish();
      return;
    }

    child.stdout?.on("data", (chunk) => stdout.add(chunk));
    child.stderr?.on("data", (chunk) => stderr.add(chunk));

    child.on("error", (error) => {
      spawnError = error;
      finish();
    });

    child.on("close", (code) => {
      exitCode = typeof code === "number" ? code : null;
      finish();
    });

    const graceMs = Math.min(5000, Math.max(500, Math.floor(timeoutMs * 0.5)));
    timer = setTimeout(() => {
      timedOut = true;
      kill();
      setTimeout(finish, 1500);
    }, timeoutMs + graceMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

/**
 * Keeps a bounded head and tail of a stream. The final truncation done by the
 * result normalizer is what enforces `maxOutputBytes` exactly.
 * @param {number} limit
 */
function createCollector(limit) {
  let head = "";
  let tail = "";
  let truncated = false;

  return {
    add(chunk) {
      let text = typeof chunk === "string" ? chunk : String(chunk);
      if (head.length < limit) {
        const room = limit - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      if (text) {
        truncated = true;
        tail = (tail + text).slice(-limit);
      }
    },
    value() {
      if (!truncated) return head;
      return `${head}\n...[output truncated]...\n${tail}`;
    },
  };
}

/**
 * @param {number} startedAt
 * @param {number} maxOutputBytes
 */
function abortedResult(startedAt, maxOutputBytes) {
  return {
    outcome: "timeout",
    counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
    tests: [],
    durationMs: Date.now() - startedAt,
    exitCode: null,
    error: "Run aborted.",
    logs: { stdout: truncateOutput("", maxOutputBytes), stderr: truncateOutput("", maxOutputBytes) },
  };
}

/**
 * @param {unknown} value
 */
function positiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}
