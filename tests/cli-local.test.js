import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "bin/falsegreen.js");
const STUB = path.join(REPO, "tests/support/stub-model.mjs");

const baseEnv = { ...process.env, NO_COLOR: "1" };
for (const key of [
  "MODEL_API_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "MODEL_DRIVER",
  "VERCEL",
  "VERCEL_OIDC_TOKEN",
  "FALSEGREEN_URL",
  "FG_KEEP_LOCAL_ARTIFACTS",
]) {
  delete baseEnv[key];
}
for (const key of Object.keys(baseEnv)) {
  if (key.startsWith("FG_")) delete baseEnv[key];
}

const tempDirs = [];
const stubs = [];

function tempDir(prefix = "fg-cli-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fixture({ requirement, source, tests, name = "case" }) {
  const dir = tempDir();
  const sourcePath = path.join(dir, "source.js");
  const testsPath = path.join(dir, "source.test.js");
  const requirementPath = path.join(dir, "requirement.txt");
  fs.writeFileSync(sourcePath, source);
  fs.writeFileSync(testsPath, tests);
  fs.writeFileSync(requirementPath, requirement);
  return { dir, name, sourcePath, testsPath, requirementPath };
}

function runCli(args, { env = {}, cwd = REPO, timeout = 120000 } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd,
    timeout,
    env: { ...baseEnv, ...env },
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function localArgs(command, fx, extra = []) {
  return [
    command,
    "--local",
    "--source",
    fx.sourcePath,
    "--tests",
    fx.testsPath,
    "--requirement",
    `@${fx.requirementPath}`,
    ...extra,
  ];
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startStub(mode = "valid") {
  const port = await freePort();
  const child = spawn(process.execPath, [STUB, String(port)], {
    env: { ...baseEnv, STUB_MODE: mode },
    stdio: "ignore",
  });
  stubs.push(child);
  let spawnError;
  child.once("error", (error) => { spawnError = error; });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return {
        port,
        env: {
          MODEL_API_BASE_URL: `http://127.0.0.1:${port}/v1`,
          MODEL_API_KEY: "stub",
          MODEL_ID: "stub-model",
        },
      };
    } catch {
      // Not listening yet.
    }
    if (spawnError || child.exitCode !== null) throw spawnError || new Error("Model stub exited before becoming ready.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Model stub did not become ready.");
}

afterAll(() => {
  for (const child of stubs) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});

const SHIPPING_SOURCE = `export function shippingFee(orderTotal) {
  return orderTotal >= 1000 ? 0 : 99;
}
`;
const SHIPPING_TESTS = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("charges shipping below the threshold", () => {
  expect(shippingFee(500)).toBe(99);
});

test("gives free shipping above the threshold", () => {
  expect(shippingFee(1500)).toBe(0);
});
`;
const SHIPPING_REQUIREMENT =
  "Orders of ₹1,000 or more receive free shipping. Orders below ₹1,000 pay ₹99 shipping.";

const COVERED_TESTS = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("charges shipping below the threshold", () => {
  expect(shippingFee(500)).toBe(99);
});

test("gives free shipping at the threshold", () => {
  expect(shippingFee(1000)).toBe(0);
});
`;

describe("falsegreen --local", () => {
  test.each([
    [["scan", "--local", "--url", "http://localhost:1"], "cannot be used together"],
    [["scan", "--local", "--local"], "more than once"],
    [["scan", "--source", "a", "--source", "b"], "more than once"],
    [["scan", "--apply"], "requires the check command"],
    [["scan", "--out", "artifacts"], "requires the check command"],
    [["scan", "--mutation", "m1"], "requires the check command"],
    [["check", "--yes"], "requires --apply"],
    [["check", "--source", "-h"], "Missing value"],
    [["check", "--unknown"], "Unknown option"],
    [["check", "--local=false"], "does not take a value"],
    [["check", "--source="], "Missing value"],
  ])("rejects invalid arguments %j before execution", (args, message) => {
    const result = runCli(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  test("help documents local mode and model configuration", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--local");
    expect(result.stdout).toContain("MODEL_API_BASE_URL");
    expect(result.stdout).toContain("No server or deployment");
  });

  test("missing required paths fail with a usage error", () => {
    const dir = tempDir();
    const sourcePath = path.join(dir, "source.js");
    fs.writeFileSync(sourcePath, "export function f() { return 1; }\n");

    const missingTests = runCli([
      "scan",
      "--local",
      "--source",
      sourcePath,
      "--requirement",
      "x",
    ]);
    expect(missingTests.status).toBe(1);
    expect(missingTests.stderr).toMatch(/--tests/i);

    const noFile = runCli([
      "scan",
      "--local",
      "--source",
      "/nope.js",
      "--tests",
      "/nope.test.js",
      "--requirement",
      "x",
    ]);
    expect(noFile.status).toBe(1);
    expect(noFile.stderr).toMatch(/not found|could not read/i);
  });

  test("oversized source is rejected before execution", () => {
    const fx = fixture({
      requirement: "Large.",
      source: `export function f() { return 1; }\n${"//".repeat(40000)}\n`,
      tests: `import { expect, test } from "vitest";\nimport { f } from "./source.js";\ntest("f", () => expect(f()).toBe(1));\n`,
    });
    const result = runCli(localArgs("scan", fx));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/65536|too large/i);
  });

  test("async exports, imports and mocks are rejected with specific codes", () => {
    const asyncFx = fixture({
      requirement: "Returns one.",
      source: `export async function load() { return 1; }\n`,
      tests: `import { expect, test } from "vitest";\nimport { load } from "./source.js";\ntest("one", async () => expect(await load()).toBe(1));\n`,
    });
    expect(runCli(localArgs("scan", asyncFx)).status).toBe(1);

    const importFx = fixture({
      requirement: "Returns one.",
      source: `import path from "node:path";\nexport function f() { return 1; }\n`,
      tests: `import { expect, test } from "vitest";\nimport { f } from "./source.js";\ntest("one", () => expect(f()).toBe(1));\n`,
    });
    const importResult = runCli(localArgs("scan", importFx));
    expect(importResult.status).toBe(1);
    expect(importResult.stderr).toMatch(/self-contained|import/i);

    const mockFx = fixture({
      requirement: "Returns one.",
      source: `export function f() { return 1; }\n`,
      tests: `import { expect, test, vi } from "vitest";\nvi.mock("./source.js");\nimport { f } from "./source.js";\ntest("one", () => expect(f()).toBe(1));\n`,
    });
    expect(runCli(localArgs("scan", mockFx)).status).toBe(1);
  });

  test("a covered boundary exits 0 with no missed mutations", () => {
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: COVERED_TESTS,
    });
    const result = runCli(localArgs("scan", fx));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("caught");
    expect(result.stdout).not.toContain("missed  2");
    expect(result.stdout).toContain("stop: complete");
  });

  test("a missed boundary exits 2 and prints the table", () => {
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: SHIPPING_TESTS,
    });
    const result = runCli(localArgs("scan", fx));
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(">= 1000 becomes > 1000");
    expect(result.stdout).toContain("missed");
    expect(result.stdout).toContain("Run check to propose a repair");
  });

  test("a module with no mutable operators exits 0", () => {
    const fx = fixture({
      requirement: "Always returns one.",
      source: `export function one() { return 1; }\n`,
      tests: `import { expect, test } from "vitest";\nimport { one } from "./source.js";\ntest("one", () => expect(one()).toBe(1));\n`,
    });
    const result = runCli(localArgs("scan", fx));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stop: no_mutations");
  });

  test("more than twelve operators are capped deterministically", () => {
    const fx = fixture({
      requirement: "The band is true from 0 to 39.",
      source: `export function band(n) {
  return (n > 0 && n < 10) || (n >= 10 && n < 20) || (n >= 20 && n < 30) || (n >= 30 && n < 40);
}
`,
      tests: `import { expect, test } from "vitest";\nimport { band } from "./source.js";\ntest("inside", () => expect(band(15)).toBe(true));\ntest("outside", () => expect(band(45)).toBe(false));\n`,
    });
    const result = runCli(localArgs("scan", fx));
    expect(result.stdout).toContain("m12");
    expect(result.stdout).not.toMatch(/\bm13\b/);
    expect(result.stdout).toContain("0 untested");
  });

  test("baseline failure stops the scan and exits 2", () => {
    const fx = fixture({
      requirement: "The fee is 99.",
      source: `export function fee() { return 99; }\n`,
      tests: `import { expect, test } from "vitest";\nimport { fee } from "./source.js";\ntest("fee", () => expect(fee()).toBe(42));\n`,
    });
    const result = runCli(localArgs("scan", fx));
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("stop: baseline_failed");
  });

  test("an all-skipped suite reports no_tests", () => {
    const fx = fixture({
      requirement: "The fee is 99.",
      source: `export function fee() { return 99; }\n`,
      tests: `import { expect, test } from "vitest";\nimport { fee } from "./source.js";\ntest.skip("fee", () => expect(fee()).toBe(99));\n`,
    });
    const result = runCli(localArgs("scan", fx));
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("stop: no_tests");
  });

  test("baseline timeout is reported and not counted as caught", () => {
    const fx = fixture({
      requirement: "Slow but correct.",
      source: `export function wait() { return 1; }\n`,
      tests: `import { expect, test } from "vitest";\nimport { wait } from "./source.js";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 4000)); expect(wait()).toBe(1); });\n`,
    });
    const result = runCli(localArgs("scan", fx), { env: { FG_TEST_TIMEOUT_MS: "1200" } });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/timeout/i);
    expect(result.stdout).toContain("0 caught");
  });

  test("--json writes one JSON document to stdout and progress to stderr", () => {
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: SHIPPING_TESTS,
    });
    const result = runCli(localArgs("scan", fx, ["--json"]));
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toMatch(/^run_/);
    expect(parsed.mutations.length).toBeGreaterThan(0);
    expect(result.stdout).not.toContain("falsegreen  mutations");
    expect(result.stderr).toContain("falsegreen");
  });

  test("check without a model explains the missing configuration", () => {
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: SHIPPING_TESTS,
    });
    const result = runCli(localArgs("check", fx));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/repair needs a model/i);
    expect(result.stderr).toContain("MODEL_API_BASE_URL");
    const json = runCli(localArgs("check", fx, ["--json"]));
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout).scan.missed).toBeGreaterThan(0);
  });

  test("a deadline before the baseline is inconclusive even with no mutations", () => {
    const fx = fixture({
      requirement: "Always returns one.",
      source: "export function one() { return 1; }",
      tests: 'import {expect,test} from "vitest"; import {one} from "./source.js"; test("one", () => expect(one()).toBe(1));',
    });
    const result = runCli(localArgs("scan", fx, ["--json"]), { env: { FG_SCAN_DEADLINE_MS: "1" } });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).scan.stopReason).toBe("deadline");
  });

  test("tests importing a different source are rejected", () => {
    const fx = fixture({ requirement: SHIPPING_REQUIREMENT, source: SHIPPING_SOURCE, tests: SHIPPING_TESTS });
    fs.writeFileSync(path.join(fx.dir, "other.js"), SHIPPING_SOURCE);
    fs.writeFileSync(fx.testsPath, SHIPPING_TESTS.replace("./source.js", "./other.js"));
    const result = runCli(localArgs("scan", fx));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("selected source file");
  });

  test("requirement files enforce byte limits and reject directories", () => {
    const fx = fixture({ requirement: "₹".repeat(1366), source: SHIPPING_SOURCE, tests: SHIPPING_TESTS });
    const tooBig = runCli(localArgs("scan", fx));
    expect(tooBig.status).toBe(1);
    expect(tooBig.stderr).toContain("4098 bytes");
    fs.rmSync(fx.requirementPath);
    fs.mkdirSync(fx.requirementPath);
    const directory = runCli(localArgs("scan", fx));
    expect(directory.status).toBe(1);
    expect(directory.stderr).toContain("not a file");
  });

  test("nested module paths produce a runnable regression patch and saved test", async () => {
    const stub = await startStub();
    const fx = fixture({ requirement: SHIPPING_REQUIREMENT, source: SHIPPING_SOURCE, tests: SHIPPING_TESTS });
    fs.mkdirSync(path.join(fx.dir, "src"));
    fs.mkdirSync(path.join(fx.dir, "tests"));
    fx.sourcePath = path.join(fx.dir, "src", "shipping $& fee.mjs");
    fx.testsPath = path.join(fx.dir, "tests", "shipping.test.js");
    fs.writeFileSync(fx.sourcePath, SHIPPING_SOURCE);
    fs.writeFileSync(fx.testsPath, SHIPPING_TESTS.replace("./source.js", () => "../src/shipping $& fee.mjs"));
    expect(spawnSync("git", ["init", "-q"], { cwd: fx.dir }).status).toBe(0);
    const outDir = path.join(fx.dir, "reports");
    const result = runCli(localArgs("check", fx, ["--out", outDir, "--apply", "--yes"]), {
      env: stub.env, cwd: path.join(fx.dir, "tests"),
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const regressionPath = path.join(fx.dir, "src", "shipping $& fee.regression.test.mjs");
    expect(fs.readFileSync(regressionPath, "utf8")).toContain('"./shipping $& fee.mjs"');
    expect(fs.readFileSync(fx.sourcePath, "utf8")).toBe(SHIPPING_SOURCE);
    const evidence = JSON.parse(fs.readFileSync(path.join(outDir, "falsegreen.evidence.json")));
    expect(evidence.local.testFileName).toBe("src/shipping $& fee.regression.test.mjs");
    expect(evidence.repair.verification.status).toBe("verified");
    expect(evidence.repair.verification.matrix).toHaveLength(4);
    expect(evidence.repair.verification.matrix.every((row) => row.status === "pass")).toBe(true);
    fs.writeFileSync(path.join(fx.dir, "package.json"), '{"type":"module"}');
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(fx.dir, "node_modules"), "dir");
    fs.writeFileSync(path.join(fx.dir, "vitest.config.mjs"), 'export default { test: { include: ["src/*.test.mjs", "reports/*.test.js"], environment: "node" } };');
    const executed = spawnSync(process.execPath, [path.join(REPO, "node_modules/vitest/vitest.mjs"), "run"], { cwd: fx.dir, encoding: "utf8", timeout: 15000 });
    expect(executed.status, executed.stderr + executed.stdout).toBe(0);
    expect(executed.stdout).toMatch(/2 passed/);
  });

  test("URL-special characters in module paths fail before execution", () => {
    const fx = fixture({ requirement: SHIPPING_REQUIREMENT, source: SHIPPING_SOURCE, tests: SHIPPING_TESTS });
    const target = path.join(fx.dir, "fee #1.js");
    fs.renameSync(fx.sourcePath, target);
    fx.sourcePath = target;
    const result = runCli(localArgs("scan", fx));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Rename the path");
  });

  test("check with a model writes a verified repair and applicable patch", async () => {
    const stub = await startStub("valid");
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: SHIPPING_TESTS,
    });
    const result = runCli(localArgs("check", fx, ["--out", path.join(fx.dir, "artifacts")]), {
      env: stub.env,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verified repair.");

    const artifactDir = path.join(fx.dir, "artifacts");
    const testPath = path.join(artifactDir, "falsegreen.generated.test.js");
    const patchPath = path.join(artifactDir, "falsegreen.patch");
    expect(fs.readFileSync(testPath, "utf8")).toContain(
      "expect(shippingFee(1000)).toBe(0);",
    );
    expect(fs.existsSync(path.join(artifactDir, "falsegreen.evidence.json"))).toBe(true);

    const check = spawnSync("git", ["apply", "--check", patchPath], {
      cwd: fx.dir,
      encoding: "utf8",
    });
    expect(check.status).toBe(0);
  });

  test("check reports a requirement mismatch and writes no patch", async () => {
    const stub = await startStub("valid");
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: `export function shippingFee(orderTotal) {\n  return orderTotal > 1000 ? 0 : 99;\n}\n`,
      tests: SHIPPING_TESTS,
    }, "mismatch");
    const outDir = path.join(fx.dir, "artifacts");
    const result = runCli(localArgs("check", fx, ["--out", outDir]), { env: stub.env });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Requirement mismatch.");
    expect(result.stdout).toContain("observed: 99");
    expect(fs.existsSync(path.join(outDir, "falsegreen.patch"))).toBe(false);
  });

  test("invalid model output is retried once and reported", async () => {
    const stub = await startStub("invalid");
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: SHIPPING_TESTS,
    });
    const result = runCli(localArgs("check", fx), { env: stub.env });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("No verified repair");
    expect(result.stdout).toMatch(/model response did not contain a JSON object/i);
  });

  test("provider failure is reported without a verified repair", async () => {
    const stub = await startStub("error");
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: SHIPPING_TESTS,
    });
    const result = runCli(localArgs("check", fx), { env: stub.env });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("No verified repair");
    expect(result.stdout).toMatch(/HTTP 500/);
  });

  test("an unknown --mutation id is rejected", async () => {
    const stub = await startStub("valid");
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: SHIPPING_TESTS,
    });
    const result = runCli(localArgs("check", fx, ["--mutation", "m99"]), { env: stub.env });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Mutation m99 was not found");
  });

  test("--apply --yes applies the verified patch in a git checkout", async () => {
    const stub = await startStub("valid");
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: SHIPPING_TESTS,
    });
    expect(spawnSync("git", ["init", "-q"], { cwd: fx.dir }).status).toBe(0);
    const result = runCli(
      localArgs("check", fx, ["--out", path.join(fx.dir, "artifacts"), "--apply", "--yes"]),
      { env: stub.env, cwd: fx.dir },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Applied patch with git apply.");
    expect(fs.existsSync(path.join(fx.dir, "source.regression.test.js"))).toBe(true);
  });

  test("a conflicting regression file makes --apply fail without overwriting it", async () => {
    const stub = await startStub();
    const fx = fixture({ requirement: SHIPPING_REQUIREMENT, source: SHIPPING_SOURCE, tests: SHIPPING_TESTS });
    expect(spawnSync("git", ["init", "-q"], { cwd: fx.dir }).status).toBe(0);
    const target = path.join(fx.dir, "source.regression.test.js");
    fs.writeFileSync(target, "// existing regression\n");
    const outDir = path.join(fx.dir, "artifacts");
    const result = runCli(localArgs("check", fx, ["--out", outDir, "--apply", "--yes"]), { env: stub.env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("git apply failed");
    expect(fs.readFileSync(target, "utf8")).toBe("// existing regression\n");
    expect(fs.existsSync(path.join(outDir, "falsegreen.patch"))).toBe(true);
  });

  test("noninteractive --apply requires --yes and preserves artifacts", async () => {
    const stub = await startStub();
    const fx = fixture({ requirement: SHIPPING_REQUIREMENT, source: SHIPPING_SOURCE, tests: SHIPPING_TESTS });
    const outDir = path.join(fx.dir, "artifacts");
    const result = runCli(localArgs("check", fx, ["--out", outDir, "--apply"]), { env: stub.env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("interactive terminal or --yes");
    expect(fs.existsSync(path.join(outDir, "falsegreen.patch"))).toBe(true);
    expect(fs.existsSync(path.join(fx.dir, "source.regression.test.js"))).toBe(false);
  });

  test("artifact output cannot overwrite a submitted test file", async () => {
    const stub = await startStub();
    const fx = fixture({ requirement: SHIPPING_REQUIREMENT, source: SHIPPING_SOURCE, tests: SHIPPING_TESTS });
    const target = path.join(fx.dir, "falsegreen.generated.test.js");
    fs.renameSync(fx.testsPath, target);
    fx.testsPath = target;
    const result = runCli(localArgs("check", fx, ["--out", fx.dir]), { env: stub.env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to overwrite an input file");
    expect(fs.readFileSync(target, "utf8")).toBe(SHIPPING_TESTS);
    expect(fs.existsSync(path.join(fx.dir, "falsegreen.patch"))).toBe(false);
  });

  test("SIGINT aborts a pending model request and removes temporary data", async () => {
    const stub = await startStub("hang");
    const fx = fixture({ requirement: SHIPPING_REQUIREMENT, source: SHIPPING_SOURCE, tests: SHIPPING_TESTS });
    const runtime = tempDir("fg-cli-model-runtime-");
    const child = spawn(process.execPath, [CLI, ...localArgs("check", fx)], {
      cwd: REPO, env: { ...baseEnv, ...stub.env, TMPDIR: runtime, MODEL_TIMEOUT_MS: "60000" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      const deadline = Date.now() + 10000;
      while (!(await (await fetch(`http://127.0.0.1:${stub.port}/health`)).json()).requests) {
        if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`Model request did not start: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      child.kill("SIGINT");
      expect(await closed).toBe(130);
      expect(stderr).toContain("Interrupted.");
      expect(fs.readdirSync(runtime)).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });


  test("a mutation that times out is inconclusive, not a clean scan", () => {
    const fx = fixture({
      requirement: "The spin function returns 1 when the flag is true.",
      source: `export function spin(flag) {
  if (flag === true) return 1;
  while (true) {}
}
`,
      tests: `import { expect, test } from "vitest";\nimport { spin } from "./source.js";\ntest("true", () => expect(spin(true)).toBe(1));\n`,
    });
    const result = runCli(localArgs("scan", fx), { env: { FG_TEST_TIMEOUT_MS: "1500" } });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/1 timeouts?/);
    expect(result.stdout).toContain("inconclusive");
    expect(result.stdout).toContain("0 caught");
  });

  test("empty requirement and oversized tests are rejected", () => {
    const empty = fixture({
      requirement: "",
      source: `export function f() { return 1; }\n`,
      tests: `import { expect, test } from "vitest";\nimport { f } from "./source.js";\ntest("f", () => expect(f()).toBe(1));\n`,
    });
    const emptyResult = runCli(localArgs("scan", empty));
    expect(emptyResult.status).toBe(1);
    expect(emptyResult.stderr).toMatch(/requirement|expected behaviour/i);

    const big = fixture({
      requirement: "Returns one.",
      source: `export function f() { return 1; }\n`,
      tests: `import { expect, test } from "vitest";\nimport { f } from "./source.js";\ntest("f", () => expect(f()).toBe(1));\n${"//".repeat(40000)}\n`,
    });
    const bigResult = runCli(localArgs("scan", big));
    expect(bigResult.status).toBe(1);
    expect(bigResult.stderr).toMatch(/65536|too large/i);
  });

  test("selecting a caught mutation is rejected", async () => {
    const stub = await startStub("valid");
    const fx = fixture({
      requirement: SHIPPING_REQUIREMENT,
      source: SHIPPING_SOURCE,
      tests: COVERED_TESTS,
    });
    const result = runCli(localArgs("check", fx, ["--mutation", "m1"]), { env: stub.env });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("only a missed mutation can be repaired");
  });

  test.each([["SIGINT", 130, "Interrupted."], ["SIGTERM", 143, "Terminated."]])("%s stops a running local scan and cleans up", async (signal, expectedCode, message) => {
    const fx = fixture({
      requirement: "Slow but correct.",
      source: `export function wait() { return 1; }\n`,
      tests: `import { expect, test } from "vitest";\nimport { wait } from "./source.js";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 5000)); expect(wait()).toBe(1); });\n`,
    });

    const runtime = tempDir("fg-cli-runtime-");
    const child = spawn(process.execPath, [CLI, ...localArgs("scan", fx)], {
      cwd: REPO,
      env: { ...baseEnv, FG_TEST_TIMEOUT_MS: "10000", TMPDIR: runtime },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      const deadline = Date.now() + 5000;
      while (!fs.readdirSync(runtime).some((name) => name.startsWith("falsegreen-") && !name.startsWith("falsegreen-cli-"))) {
        if (Date.now() >= deadline) throw new Error(`Runner did not start: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      child.kill(signal);
      const code = await closed;
      expect(code).toBe(expectedCode);
      expect(stderr).toContain(message);
      expect(fs.readdirSync(runtime)).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30000);
});
