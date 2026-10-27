import { promises as fs } from "node:fs";
import path from "node:path";

import { ConfigError } from "../errors.js";
import { createLocalRunner, repositoryRoot } from "./local-runner.js";
import { createSandboxRunner } from "./sandbox-runner.js";

/**
 * @typedef {object} ExecutionResult
 * @property {"completed" | "timeout" | "error"} outcome
 * @property {{ total: number, passed: number, failed: number, skipped: number }} counts
 * @property {Array<{ name: string, status: "passed" | "failed" | "skipped", failureMessages: string[] }>} tests
 * @property {number} durationMs
 * @property {number | null} exitCode
 * @property {string | null} error
 * @property {{ stdout: string, stderr: string }} logs
 */

/**
 * @typedef {object} Runner
 * @property {(input: {
 *   files: { "source.js"?: string, "source.test.js"?: string },
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }) => Promise<ExecutionResult>} runTests
 */

/**
 * @typedef {object} RunnerConfig
 * @property {string} [execution.driver]
 * @property {string} [execution.sandboxSnapshotId]
 * @property {boolean} [execution.keepLocalArtifacts]
 * @property {{ maxOutputBytes?: number, testTimeoutMs?: number }} [limits]
 */

/**
 * @param {RunnerConfig} config
 * @returns {Runner}
 */
export function createRunner(config) {
  const driver = config?.execution?.driver || "local";

  if (driver === "local") return createLocalRunner(config);
  if (driver === "sandbox") return createSandboxRunner(config);

  throw new ConfigError(
    `Unknown execution driver "${driver}". Set EXECUTION_DRIVER to "local" or "sandbox".`,
  );
}

/**
 * Fail fast before a job is queued. This never creates a sandbox.
 * @param {RunnerConfig} config
 * @returns {Promise<void>}
 */
export async function assertRunnerAvailable(config) {
  const driver = config?.execution?.driver || "local";

  if (driver === "local") {
    const vitestEntry = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
    try {
      const stat = await fs.stat(vitestEntry);
      if (!stat.isFile()) throw new Error("not a file");
    } catch {
      throw new ConfigError(
        "Local execution requires the project's Vitest install. Run `npm install` and retry.",
      );
    }
    return;
  }

  if (driver === "sandbox") {
    const snapshotId = config?.execution?.sandboxSnapshotId?.trim?.() || "";
    if (!snapshotId) {
      throw new ConfigError(
        "Sandbox execution requires VERCEL_SANDBOX_SNAPSHOT_ID pointing at a snapshot with Node and Vitest installed. Run `node scripts/build-sandbox-snapshot.mjs` to build one.",
      );
    }
    return;
  }

  throw new ConfigError(
    `Unknown execution driver "${driver}". Set EXECUTION_DRIVER to "local" or "sandbox".`,
  );
}

export { createLocalRunner, createSandboxRunner };
