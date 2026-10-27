import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { loadConfig } from "../src/core/config.js";
import {
  assertRunnerAvailable,
  createRunner,
  createSandboxRunner,
} from "../src/core/execution/index.js";
import {
  normalizeVitestJson,
  parseVitestFailure,
} from "../src/core/execution/vitest-results.js";

const config = loadConfig({});
const runner = createRunner(config);

let baselineTempDirs = new Set();

async function tempRunDirs() {
  const entries = await fs.readdir(os.tmpdir());
  return new Set(entries.filter((name) => /^falsegreen-/.test(name)));
}

function newDirs(before, after) {
  return [...after].filter((name) => !before.has(name)).sort();
}

beforeAll(async () => {
  baselineTempDirs = await tempRunDirs();
});

afterAll(async () => {
  expect(newDirs(baselineTempDirs, await tempRunDirs())).toEqual([]);
});

describe("local runner", () => {
  test("runs a passing suite and removes its temp directory", async () => {
    const before = await tempRunDirs();

    const result = await runner.runTests({
      files: {
        "source.js": "export function add(a, b) { return a + b; }\n",
        "source.test.js": `import { expect, test } from "vitest";
import { add } from "./source.js";

test("adds two numbers", () => {
  expect(add(2, 3)).toBe(5);
});
`,
      },
      timeoutMs: 8000,
    });

    expect(result.outcome).toBe("completed");
    expect(result.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeNull();
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0]).toMatchObject({
      name: "adds two numbers",
      status: "passed",
      failureMessages: [],
    });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(typeof result.logs.stdout).toBe("string");
    expect(typeof result.logs.stderr).toBe("string");

    expect(newDirs(before, await tempRunDirs())).toEqual([]);
  });

  test("reports an assertion failure as completed and parses its operands", async () => {
    const result = await runner.runTests({
      files: {
        "source.js": "export function add(a, b) { return a + b; }\n",
        "source.test.js": `import { expect, test } from "vitest";
import { add } from "./source.js";

test("adds two numbers", () => {
  expect(add(1, 2)).toBe(4);
});
`,
      },
      timeoutMs: 8000,
    });

    expect(result.outcome).toBe("completed");
    expect(result.counts).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0 });
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeNull();
    expect(result.tests[0].status).toBe("failed");
    expect(result.tests[0].failureMessages.length).toBeGreaterThan(0);

    const parsed = parseVitestFailure(result.tests[0].failureMessages[0]);
    expect(parsed).toEqual({ kind: "assertion", actual: 3, expected: 4 });
  });

  test("reports a source syntax error as an execution error", async () => {
    const result = await runner.runTests({
      files: {
        "source.js": "export function add(a, b) { return a + }\n",
        "source.test.js": `import { expect, test } from "vitest";
import { add } from "./source.js";

test("adds two numbers", () => {
  expect(add(1, 2)).toBe(3);
});
`,
      },
      timeoutMs: 8000,
    });

    expect(result.outcome).toBe("error");
    expect(result.counts).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(result.error).toMatch(/parse|unexpected token/i);
  });

  test("keeps a zero-test suite distinct from an execution error", async () => {
    const result = await runner.runTests({
      files: {
        "source.js": "export function add(a, b) { return a + b; }\n",
        "source.test.js": `import { test } from "vitest";
import { add } from "./source.js";
void test;
void add;
`,
      },
      timeoutMs: 8000,
    });

    expect(result.outcome).toBe("completed");
    expect(result.counts).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(result.tests).toEqual([]);
    expect(result.error).toBeNull();
  });

  test("kills a hanging suite and reports timeout", async () => {
    const result = await runner.runTests({
      files: {
        "source.js": "export function add(a, b) { return a + b; }\n",
        "source.test.js": `import { expect, test } from "vitest";
import { add } from "./source.js";

test("waits too long", async () => {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  expect(add(1, 2)).toBe(3);
});
`,
      },
      timeoutMs: 1200,
    });

    expect(result.outcome).toBe("timeout");
    expect(result.durationMs).toBeLessThan(4500);
  });

  test("isolates concurrent runs and removes both temp directories", async () => {
    const before = await tempRunDirs();

    const [left, right] = await Promise.all([
      runner.runTests({
        files: {
          "source.js": "export function add(a, b) { return a + b; }\n",
          "source.test.js": `import { expect, test } from "vitest";
import { add } from "./source.js";

test("adds", () => {
  expect(add(7, 8)).toBe(15);
});
`,
        },
        timeoutMs: 8000,
      }),
      runner.runTests({
        files: {
          "source.js": "export function multiply(a, b) { return a * b; }\n",
          "source.test.js": `import { expect, test } from "vitest";
import { multiply } from "./source.js";

test("multiplies", () => {
  expect(multiply(6, 7)).toBe(42);
});
`,
        },
        timeoutMs: 8000,
      }),
    ]);

    expect(left.outcome).toBe("completed");
    expect(left.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(left.tests.map((item) => item.name)).toEqual(["adds"]);

    expect(right.outcome).toBe("completed");
    expect(right.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(right.tests.map((item) => item.name)).toEqual(["multiplies"]);

    expect(newDirs(before, await tempRunDirs())).toEqual([]);
  });

  test("supports aborting an in-flight run", async () => {
    const controller = new AbortController();
    const pending = runner.runTests({
      files: {
        "source.js": "export function add(a, b) { return a + b; }\n",
        "source.test.js": `import { expect, test } from "vitest";
import { add } from "./source.js";

test("waits too long", async () => {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  expect(add(1, 2)).toBe(3);
});
`,
      },
      timeoutMs: 10000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 150);
    const result = await pending;

    expect(result.outcome).toBe("timeout");
    expect(result.error).toMatch(/aborted/i);
  });
});

describe("result normalization", () => {
  test("accepts failureMessage strings and marks pending tests skipped", () => {
    const result = normalizeVitestJson(
      {
        success: false,
        testResults: [
          {
            assertionResults: [
              {
                fullName: "works",
                status: "failed",
                failureMessage: "AssertionError: expected 1 to be 2",
              },
              { fullName: "later", status: "pending", failureMessages: null },
              { fullName: "todo", status: "todo" },
            ],
          },
        ],
      },
      { durationMs: 12, exitCode: 1 },
    );

    expect(result.outcome).toBe("completed");
    expect(result.counts).toEqual({ total: 3, passed: 0, failed: 1, skipped: 2 });
    expect(result.tests[0].failureMessages).toEqual([
      "AssertionError: expected 1 to be 2",
    ]);
  });

  test("parses deeply-equal failures", () => {
    expect(
      parseVitestFailure("AssertionError: expected [ 1 ] to deeply equal [ 1, 2 ]"),
    ).toEqual({ kind: "assertion", actual: [1], expected: [1, 2] });
  });

  test("truncates logs to maxOutputBytes", () => {
    const result = normalizeVitestJson(null, {
      stdout: "a".repeat(8000),
      stderr: "b".repeat(8000),
      maxOutputBytes: 1024,
    });

    expect(Buffer.byteLength(result.logs.stdout, "utf8")).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(result.logs.stderr, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.logs.stdout).toContain("truncated");
  });
});

describe("sandbox runner configuration and client contract", () => {
  test("fails clearly without a snapshot id", async () => {
    expect(() =>
      createSandboxRunner({ execution: { driver: "sandbox" } }),
    ).toThrow(/VERCEL_SANDBOX_SNAPSHOT_ID/);

    await expect(
      assertRunnerAvailable({ execution: { driver: "sandbox", sandboxSnapshotId: "" } }),
    ).rejects.toThrow(/VERCEL_SANDBOX_SNAPSHOT_ID/);
  });

  test("uses the snapshot, deny-all network, filesystem, command and stop APIs", async () => {
    const createCalls = [];
    const writeCalls = [];
    const commandCalls = [];
    const mkdirCalls = [];
    let stopCalls = 0;

    const json = {
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      success: true,
      testResults: [
        {
          assertionResults: [
            { fullName: "works", status: "passed", failureMessages: [] },
          ],
        },
      ],
    };

    const sandbox = {
      fs: {
        mkdir: async (target, options) => mkdirCalls.push({ target, options }),
        readFile: async (target, encoding) => {
          expect(target).toBe("/tmp/falsegreen/run/results.json");
          expect(encoding).toBe("utf8");
          return JSON.stringify(json);
        },
      },
      writeFiles: async (files, options) => writeCalls.push({ files, options }),
      runCommand: async (params) => {
        commandCalls.push(params);
        return {
          exitCode: 0,
          stdout: async () => "JSON report written",
          stderr: async () => "",
        };
      },
      stop: async () => {
        stopCalls += 1;
      },
    };

    const sandboxRunner = createSandboxRunner(
      {
        limits: { maxOutputBytes: 65536, testTimeoutMs: 10000 },
        execution: { driver: "sandbox", sandboxSnapshotId: "snap_test_123" },
      },
      {
        createSandbox: async (params) => {
          createCalls.push(params);
          return sandbox;
        },
      },
    );

    const result = await sandboxRunner.runTests({
      files: {
        "source.js": "export function add(a, b) { return a + b; }\n",
        "source.test.js": `import { expect, test } from "vitest";
import { add } from "./source.js";
test("adds", () => expect(add(1, 2)).toBe(3));
`,
      },
      timeoutMs: 5000,
    });

    expect(createCalls).toEqual([
      {
        source: { type: "snapshot", snapshotId: "snap_test_123" },
        networkPolicy: "deny-all",
        ports: [],
        timeout: 60000,
      },
    ]);
    expect(mkdirCalls).toEqual([
      { target: "/tmp/falsegreen/run", options: { recursive: true, signal: undefined } },
    ]);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].files.map((file) => file.path)).toEqual([
      "/tmp/falsegreen/run/package.json",
      "/tmp/falsegreen/run/vitest.config.mjs",
      "/tmp/falsegreen/run/source.js",
      "/tmp/falsegreen/run/source.test.js",
    ]);

    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toMatchObject({
      cmd: "node",
      cwd: "/tmp/falsegreen/run",
      timeoutMs: 5000,
    });
    expect(commandCalls[0].args).toEqual([
      "/opt/falsegreen/node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.config.mjs",
      "--reporter=json",
      "--outputFile=results.json",
      "--no-color",
    ]);
    expect(commandCalls[0].env).toBeUndefined();

    expect(result.outcome).toBe("completed");
    expect(result.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(result.exitCode).toBe(0);
    expect(stopCalls).toBe(1);
  });

  test("stops the sandbox and reports command failures", async () => {
    let stopCalls = 0;
    const sandbox = {
      fs: {
        mkdir: async () => {},
        readFile: async () => {
          throw new Error("missing");
        },
      },
      writeFiles: async () => {},
      runCommand: async () => {
        throw new Error("sandbox timed out");
      },
      stop: async () => {
        stopCalls += 1;
      },
    };

    const sandboxRunner = createSandboxRunner(
      { execution: { driver: "sandbox", sandboxSnapshotId: "snap_test_123" } },
      { createSandbox: async () => sandbox },
    );

    const result = await sandboxRunner.runTests({
      files: { "source.js": "", "source.test.js": "" },
      timeoutMs: 5000,
    });

    expect(result.outcome).toBe("timeout");
    expect(stopCalls).toBe(1);
  });
});
