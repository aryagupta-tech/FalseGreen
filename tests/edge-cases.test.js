import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_LIMITS, loadConfig } from "../src/core/config.js";
import { applyMutation, collectMutations } from "../src/core/mutations.js";
import { createStore } from "../src/core/store/index.js";
import { createRunner } from "../src/core/execution/index.js";
import {
  createRun,
  enqueueScan,
  requestRepair,
  runKey,
} from "../src/core/jobs/engine.js";
import { driveRun } from "../src/core/jobs/driver.js";
import { parseModule, validateInput } from "../src/core/validate-input.js";

const SECRET = "sk-edge-secret-do-not-leak";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix = "falsegreen-edge-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function scriptedModel(propose) {
  return {
    describe: () => ({ driver: "scripted-edge", id: "scripted-edge-v1" }),
    proposeTest: async (input) => {
      const proposal = await propose(input);
      return proposal;
    },
  };
}

async function makeHarness({ model, env = {} } = {}) {
  const dir = await tempDir();
  const config = loadConfig({
    STORE_DRIVER: "file",
    FG_DATA_DIR: dir,
    EXECUTION_DRIVER: "local",
    MODEL_DRIVER: "openai-compatible",
    MODEL_API_BASE_URL: "http://127.0.0.1:9/v1",
    MODEL_API_KEY: SECRET,
    MODEL_ID: "scripted-edge-v1",
    ...env,
  });
  config.jobDriver = "inline";
  config.deps = {
    createModel: async () => model,
  };
  const store = createStore(config);

  return {
    dir,
    config,
    store,
    async scan(input) {
      const run = await createRun({
        store,
        limits: config.limits,
        sessionId: "edge-session",
        input,
      });
      await enqueueScan({ store, config, run, schedule: false });
      await driveRun({ store, config, runId: run.id });
      return store.get(runKey(run.id));
    },
    async repair(run, mutationId) {
      await requestRepair({
        store,
        limits: config.limits,
        config,
        runId: run.id,
        mutationId,
        schedule: false,
      });
      await driveRun({ store, config, runId: run.id });
      return store.get(runKey(run.id));
    },
  };
}

function testsFor(importName, body) {
  return `import { expect, test } from "vitest";
import { ${importName} } from "./source.js";

${body}
`;
}

describe("real-world edge cases", () => {
  test("password policy: boundary is missed, logical mutation is caught, exact 8 verifies", async () => {
    const source = `export function isStrongPassword(password) {
  return password.length >= 8 && /[0-9]/.test(password) && /[A-Z]/.test(password);
}
`;
    const tests = testsFor(
      "isStrongPassword",
      `test("rejects a seven character password", () => {
  expect(isStrongPassword("Abcdef1")).toBe(false);
});

test("rejects a password without a digit", () => {
  expect(isStrongPassword("Abcdefgh")).toBe(false);
});

test("accepts a long mixed password", () => {
  expect(isStrongPassword("Abcdefg12")).toBe(true);
});`,
    );

    const harness = await makeHarness({
      model: scriptedModel(() => ({
        title: "accepts a password at exactly eight characters",
        exportName: "isStrongPassword",
        args: ["Abcdefg1"],
        expected: true,
        rationale: "The requirement sets the minimum length at exactly eight.",
      })),
    });

    const run = await harness.scan({
      requirement:
        "A strong password is at least 8 characters and contains a digit and an uppercase letter.",
      source,
      tests,
    });

    expect(run.status).toBe("completed");
    expect(run.baseline.counts).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0 });
    expect(run.exports).toEqual([{ name: "isStrongPassword", kind: "function" }]);

    const boundary = run.mutations.find(
      (mutation) => mutation.family === "boundary" && mutation.operator === ">=",
    );
    const logical = run.mutations.filter((mutation) => mutation.family === "logical");
    expect(boundary).toMatchObject({ status: "missed", replacement: ">" });
    expect(logical).toHaveLength(2);
    expect(logical.every((mutation) => mutation.status === "caught")).toBe(true);
    expect(run.scan).toMatchObject({
      tested: 4,
      caught: 3,
      missed: 1,
      errors: 0,
      timeouts: 0,
      untested: 0,
      stopReason: "complete",
    });

    const repaired = await harness.repair(run, boundary.id);
    expect(repaired.repair.status).toBe("verified");
    expect(repaired.repair.generatedTest).toContain(
      'expect(isStrongPassword("Abcdefg1")).toBe(true);',
    );
    expect(repaired.repair.verification.matrix.map((row) => row.observed)).toEqual([
      "pass",
      "pass",
      "pass",
      "fail",
    ]);
  });

  test("tiered pricing: mixed caught/missed counts and the gold 500 boundary verifies", async () => {
    const source = `export function applyDiscount(total, tier) {
  return tier === "gold"
    ? total >= 500
      ? total * 0.8
      : total * 0.9
    : tier === "silver"
      ? total >= 250
        ? total * 0.9
        : total
      : total;
}
`;
    const tests = testsFor(
      "applyDiscount",
      `test("gold volume orders get twenty percent off", () => {
  expect(applyDiscount(600, "gold")).toBe(480);
});

test("gold orders below five hundred get ten percent off", () => {
  expect(applyDiscount(400, "gold")).toBe(360);
});

test("silver volume orders get ten percent off", () => {
  expect(applyDiscount(300, "silver")).toBe(270);
});

test("small silver orders pay full price", () => {
  expect(applyDiscount(200, "silver")).toBe(200);
});

test("other tiers pay full price", () => {
  expect(applyDiscount(600, "bronze")).toBe(600);
});`,
    );

    const harness = await makeHarness({
      model: scriptedModel(() => ({
        title: "applies the gold discount at exactly five hundred",
        exportName: "applyDiscount",
        args: [500, "gold"],
        expected: 400,
        rationale: "Gold orders of exactly 500 qualify for the volume rate.",
      })),
    });

    const run = await harness.scan({
      requirement:
        "Gold orders of 500 or more get 20 percent off, otherwise 10 percent. Silver orders of 250 or more get 10 percent off, otherwise full price. Other tiers pay full price.",
      source,
      tests,
    });

    expect(run.baseline.counts).toEqual({ total: 5, passed: 5, failed: 0, skipped: 0 });

    const equality = run.mutations.filter((mutation) => mutation.family === "equality");
    const comparisons = run.mutations.filter((mutation) => mutation.family === "comparison");
    const boundaries = run.mutations.filter((mutation) => mutation.family === "boundary");
    expect(equality).toHaveLength(2);
    expect(comparisons).toHaveLength(2);
    expect(boundaries).toHaveLength(2);
    expect(equality.every((mutation) => mutation.status === "caught")).toBe(true);
    expect(comparisons.every((mutation) => mutation.status === "caught")).toBe(true);
    expect(boundaries.every((mutation) => mutation.status === "missed")).toBe(true);
    expect(run.scan).toMatchObject({
      tested: 6,
      caught: 4,
      missed: 2,
      errors: 0,
      timeouts: 0,
      untested: 0,
      stopReason: "complete",
    });

    const goldBoundary = boundaries.find((mutation) => mutation.after.includes("total > 500"));
    expect(goldBoundary).toBeTruthy();

    const repaired = await harness.repair(run, goldBoundary.id);
    expect(repaired.repair.status).toBe("verified");
    expect(repaired.repair.generatedTest).toContain(
      'expect(applyDiscount(500, "gold")).toBe(400);',
    );
  });

  test("object return: generated test uses toEqual and verification succeeds with exact source", async () => {
    const source = `export function classifyScore(score) {
  return {
    grade: score >= 90 ? "A" : score >= 70 ? "B" : "C",
    pass: score >= 70,
  };
}
`;
    const tests = testsFor(
      "classifyScore",
      `test("classifies a high score", () => {
  expect(classifyScore(95)).toEqual({ grade: "A", pass: true });
});

test("classifies a passing score", () => {
  expect(classifyScore(75)).toEqual({ grade: "B", pass: true });
});

test("classifies a failing score", () => {
  expect(classifyScore(60)).toEqual({ grade: "C", pass: false });
});`,
    );

    const harness = await makeHarness({
      model: scriptedModel(() => ({
        title: "keeps 90 in the A grade",
        exportName: "classifyScore",
        args: [90],
        expected: { grade: "A", pass: true },
        rationale: "The requirement includes exactly 90 in the A band.",
      })),
    });

    const run = await harness.scan({
      requirement:
        "Scores of 90 or more get an A, 70 or more get a B, and lower scores get a C. Passing means 70 or more.",
      source,
      tests,
    });

    expect(run.baseline.counts).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0 });
    const firstBoundary = run.mutations.find(
      (mutation) => mutation.family === "boundary" && mutation.after.includes("score > 90"),
    );
    expect(firstBoundary).toMatchObject({ status: "missed" });
    expect(run.scan).toMatchObject({ tested: 6, caught: 3, missed: 3 });

    const repaired = await harness.repair(run, firstBoundary.id);
    expect(repaired.repair.status).toBe("verified");
    expect(repaired.repair.generatedTest).toBe(
      `import { expect, test } from "vitest";
import { classifyScore } from "./source.js";

test("keeps 90 in the A grade", () => {
  expect(classifyScore(90)).toEqual({"grade":"A","pass":true});
});
`,
    );
    expect(repaired.repair.verification.matrix.map((row) => row.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });

  test("multi-export module: both exports are discovered and canVote proposals import canVote", async () => {
    const source = `export function isAdult(age) {
  return age >= 18;
}

export function canVote(age) {
  return age >= 18 && age < 120;
}
`;
    const tests = testsFor(
      "isAdult",
      `test("rejects minors", () => {
  expect(isAdult(17)).toBe(false);
});

test("accepts adults", () => {
  expect(isAdult(18)).toBe(true);
});`,
    );

    const harness = await makeHarness({
      model: scriptedModel(() => ({
        title: "allows voting at exactly eighteen",
        exportName: "canVote",
        args: [18],
        expected: true,
        rationale: "The requirement makes 18 the inclusive voting age.",
      })),
    });

    const run = await harness.scan({
      requirement:
        "isAdult is true at 18 or older. canVote is true at 18 or older and under 120.",
      source,
      tests,
    });

    expect(run.exports).toEqual([
      { name: "isAdult", kind: "function" },
      { name: "canVote", kind: "function" },
    ]);

    const canVoteStart = source.indexOf("export function canVote");
    const adultMutations = run.mutations.filter((mutation) => mutation.start < canVoteStart);
    const votingMutations = run.mutations.filter((mutation) => mutation.start > canVoteStart);
    expect(adultMutations).toHaveLength(2);
    expect(adultMutations.every((mutation) => mutation.status === "caught")).toBe(true);
    expect(votingMutations).toHaveLength(5);
    expect(votingMutations.every((mutation) => mutation.status === "missed")).toBe(true);
    expect(run.scan).toMatchObject({
      tested: 7,
      caught: 2,
      missed: 5,
      untested: 0,
      stopReason: "complete",
    });

    const boundary = votingMutations.find(
      (mutation) => mutation.family === "boundary" && mutation.operator === ">=",
    );
    const repaired = await harness.repair(run, boundary.id);

    expect(repaired.repair.status).toBe("verified");
    expect(repaired.repair.generatedTest).toContain(
      'import { canVote } from "./source.js";',
    );
    expect(repaired.repair.generatedTest).toContain("expect(canVote(18)).toBe(true);");
    expect(repaired.repair.generatedTest).not.toContain("isAdult(");
  });

  test("minified source keeps a comment between operands through every mutation", () => {
    const source =
      'export function canDrive(age,licensed){return age>=16/* minimum age */&&licensed===true;}\n';
    const comment = "/* minimum age */";
    const mutations = collectMutations(source);

    expect(mutations).toHaveLength(4);
    expect(mutations.map((mutation) => mutation.family)).toEqual([
      "boundary",
      "comparison",
      "logical",
      "equality",
    ]);

    for (const mutation of mutations) {
      expect(source.slice(mutation.start, mutation.end)).toBe(mutation.operator);
      const mutated = applyMutation(source, mutation);
      expect(mutated).toBe(mutation.after);
      expect(mutated.split(comment)).toHaveLength(2);
      expect(() => parseModule(mutated)).not.toThrow();
      expect(mutated.slice(0, mutation.start)).toBe(source.slice(0, mutation.start));
      expect(mutated.slice(mutation.end + (mutation.replacement.length - mutation.operator.length))).toBe(
        source.slice(mutation.end),
      );
    }
  });

  test("mutation cap: exactly 12 deterministic mutations with boundary before comparison", () => {
    const source = `export function gate(a, b, c, d, e, f, g, h) {
  return a >= 1 && b >= 2 && c >= 3 && d >= 4 && e >= 5 && f >= 6 && g >= 7 && h >= 8;
}
`;
    const uncapped = collectMutations(source, { maxMutations: 100 });
    const capped = collectMutations(source);
    const repeated = collectMutations(source);

    expect(uncapped.length).toBeGreaterThan(12);
    expect(capped).toHaveLength(12);
    expect(repeated).toEqual(capped);
    expect(capped.map((mutation) => mutation.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `m${index + 1}`),
    );

    const starts = capped.map((mutation) => mutation.start);
    expect(starts).toEqual([...starts].sort((left, right) => left - right));

    const byStart = new Map();
    capped.forEach((mutation, index) => {
      const group = byStart.get(mutation.start) ?? [];
      group.push({ mutation, index });
      byStart.set(mutation.start, group);
    });
    for (const group of byStart.values()) {
      const boundary = group.find((entry) => entry.mutation.family === "boundary");
      const comparison = group.find((entry) => entry.mutation.family === "comparison");
      if (boundary && comparison) {
        expect(boundary.mutation.operator).toBe(comparison.mutation.operator);
        expect(boundary.index).toBeLessThan(comparison.index);
      }
    }
  });

  test("validateInput rejects unsafe and empty submissions with specific codes", () => {
    const source = "export function isPositive(value) {\n  return value > 0;\n}\n";
    const tests = testsFor(
      "isPositive",
      `test("accepts a positive number", () => {
  expect(isPositive(1)).toBe(true);
});`,
    );
    const base = {
      requirement: "isPositive is true only for numbers greater than zero.",
      source,
      tests,
    };

    expect(validateInput(base, DEFAULT_LIMITS)).toMatchObject({
      ok: true,
      exports: [{ name: "isPositive", kind: "function" }],
    });

    const cases = [
      {
        name: "async export",
        input: {
          ...base,
          source: "export async function isPositive(value) {\n  return value > 0;\n}\n",
        },
        field: "source",
        code: "unsupported_export",
      },
      {
        name: "source import",
        input: {
          ...base,
          source:
            'import path from "node:path";\nexport function isPositive(value) {\n  return value > 0 && path.sep;\n}\n',
        },
        field: "source",
        code: "unsupported_import",
      },
      {
        name: "vi.mock",
        input: {
          ...base,
          tests: `import { expect, test, vi } from "vitest";
import { isPositive } from "./source.js";

vi.mock("./source.js");

test("accepts a positive number", () => {
  expect(isPositive(1)).toBe(true);
});
`,
        },
        field: "tests",
        code: "unsupported_mock",
      },
      {
        name: "tests that never import the source",
        input: {
          ...base,
          tests: `import { expect, test } from "vitest";

test("only tests a literal", () => {
  expect(1).toBe(1);
});
`,
        },
        field: "tests",
        code: "tests_do_not_import_source",
      },
      {
        name: "zero tests",
        input: {
          ...base,
          tests: `import { isPositive } from "./source.js";

void isPositive;
`,
        },
        field: "tests",
        code: "no_tests",
      },
      {
        name: "oversize source",
        input: {
          ...base,
          source: `${source}// ${"x".repeat(DEFAULT_LIMITS.maxSourceBytes)}\n`,
        },
        field: "source",
        code: "source_too_large",
      },
      {
        name: "empty requirement",
        input: { ...base, requirement: "  \n\t" },
        field: "requirement",
        code: "requirement_empty",
      },
    ];

    for (const scenario of cases) {
      const result = validateInput(scenario.input, DEFAULT_LIMITS);
      expect(result.ok, scenario.name).toBe(false);
      expect(result.errors, scenario.name).toContainEqual(
        expect.objectContaining({ field: scenario.field, code: scenario.code }),
      );
    }
  });

  test("baseline failure stops the scan before any mutation is tested", async () => {
    const source =
      'export function threshold(value) {\n  return value >= 10 ? "high" : "low";\n}\n';
    const tests = testsFor(
      "threshold",
      `test("is wrong on purpose", () => {
  expect(threshold(5)).toBe("high");
});`,
    );
    const harness = await makeHarness({
      model: scriptedModel(() => {
        throw new Error("the model must not run for a failed baseline");
      }),
    });

    const run = await harness.scan({
      requirement: "double returns twice its input.",
      source,
      tests,
    });

    expect(run.status).toBe("completed");
    expect(run.scan.stopReason).toBe("baseline_failed");
    expect(run.baseline.outcome).toBe("completed");
    expect(run.baseline.counts).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0 });
    expect(run.scan.tested).toBe(0);
    expect(run.mutations).toHaveLength(2);
    expect(run.mutations.every((mutation) => mutation.status === "untested")).toBe(true);
  });

  test("an all-skipped suite stops with no_tests instead of scanning", async () => {
    const source =
      'export function threshold(value) {\n  return value >= 10 ? "high" : "low";\n}\n';
    const tests = `import { test } from "vitest";
import { threshold } from "./source.js";

test.skip("never runs", () => {
  expect(threshold(10)).toBe("high");
});
`;
    const harness = await makeHarness({
      model: scriptedModel(() => {
        throw new Error("the model must not run for a skipped baseline");
      }),
    });

    const run = await harness.scan({
      requirement: "threshold returns high at 10 or above and low below 10.",
      source,
      tests,
    });

    expect(run.status).toBe("completed");
    expect(run.scan.stopReason).toBe("no_tests");
    expect(run.baseline.outcome).toBe("completed");
    expect(run.baseline.counts).toEqual({ total: 1, passed: 0, failed: 0, skipped: 1 });
    expect(run.scan.tested).toBe(0);
    expect(run.mutations).toHaveLength(2);
    expect(run.mutations.every((mutation) => mutation.status === "untested")).toBe(true);
  });

  test("a slow baseline with a short timeout stops with a baseline timeout", async () => {
    const source =
      'export function threshold(value) {\n  return value >= 10 ? "high" : "low";\n}\n';
    const tests = `import { expect, test } from "vitest";
import { threshold } from "./source.js";

test("takes too long", async () => {
  await new Promise((resolve) => setTimeout(resolve, 8000));
  expect(threshold(10)).toBe("high");
});
`;
    const harness = await makeHarness({
      model: scriptedModel(() => {
        throw new Error("the model must not run for a timed out baseline");
      }),
      env: { FG_TEST_TIMEOUT_MS: "1500" },
    });

    const run = await harness.scan({
      requirement: "threshold returns high at 10 or above and low below 10.",
      source,
      tests,
    });

    expect(run.status).toBe("completed");
    expect(run.baseline.outcome).toBe("timeout");
    expect(run.scan.stopReason).toBe("baseline_failed");
    expect(run.scan.tested).toBe(0);
    expect(run.mutations).toHaveLength(2);
    expect(run.mutations.every((mutation) => mutation.status === "untested")).toBe(true);
  }, 20000);

  test("a mutant test that sleeps only on its path is a timeout, never caught", async () => {
    const source = `export function route(value) {
  return value >= 10 ? "slow" : "fast";
}
`;
    const tests = testsFor(
      "route",
      `test("keeps small values on the fast path", async () => {
  const result = route(5);
  if (result === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  expect(result).toBe("fast");
});`,
    );
    const harness = await makeHarness({
      model: scriptedModel(() => {
        throw new Error("the model must not run for a timeout classification");
      }),
      env: { FG_TEST_TIMEOUT_MS: "2500" },
    });

    const run = await harness.scan({
      requirement: "route returns fast below 10 and slow at 10 or above.",
      source,
      tests,
    });

    expect(run.baseline.outcome).toBe("completed");
    expect(run.baseline.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });

    const boundary = run.mutations.find((mutation) => mutation.family === "boundary");
    const comparison = run.mutations.find((mutation) => mutation.family === "comparison");
    expect(boundary.status).toBe("missed");
    expect(comparison.status).toBe("timeout");
    expect(comparison.reason).toMatch(/timed out|timeout/i);
    expect(run.scan).toMatchObject({
      tested: 2,
      caught: 0,
      missed: 1,
      timeouts: 1,
      errors: 0,
      untested: 0,
    });
  }, 20000);

  test("verified artifacts apply with git and the generated test passes on the original source", async () => {
    const source = `export function accessLevel(score) {
  return score >= 50 ? "standard" : "restricted";
}
`;
    const tests = testsFor(
      "accessLevel",
      `test("grants standard access above fifty", () => {
  expect(accessLevel(80)).toBe("standard");
});

test("restricts low scores", () => {
  expect(accessLevel(20)).toBe("restricted");
});`,
    );
    const harness = await makeHarness({
      model: scriptedModel(() => ({
        title: "grants standard access at exactly fifty",
        exportName: "accessLevel",
        args: [50],
        expected: "standard",
        rationale: "The requirement includes exactly 50 in standard access.",
      })),
    });

    const run = await harness.scan({
      requirement: "Scores of 50 or more get standard access; lower scores are restricted.",
      source,
      tests,
    });
    const boundary = run.mutations.find(
      (mutation) => mutation.family === "boundary" && mutation.status === "missed",
    );
    expect(boundary).toBeTruthy();

    const repaired = await harness.repair(run, boundary.id);
    expect(repaired.repair.status).toBe("verified");

    const artifacts = repaired.repair.artifacts;
    expect(Object.keys(artifacts).sort()).toEqual([
      "falsegreen.evidence.json",
      "falsegreen.generated.test.js",
      "falsegreen.patch",
    ]);

    const generated = artifacts["falsegreen.generated.test.js"];
    expect(generated).toContain("expect(accessLevel(50)).toBe(\"standard\");");

    for (const [name, content] of Object.entries(artifacts)) {
      expect(content, name).not.toContain(SECRET);
      expect(content, name).not.toMatch(/MODEL_API_KEY|Authorization|Bearer /);
    }
    const evidence = JSON.parse(artifacts["falsegreen.evidence.json"]);
    expect(evidence.repair.status).toBe("verified");
    expect(evidence.repair.generatedTest).toBe(generated);
    expect(evidence.model).toEqual({ driver: "scripted-edge", id: "scripted-edge-v1" });

    const repo = await tempDir("falsegreen-edge-repo-");
    await writeFile(path.join(repo, "source.js"), source, "utf8");
    await writeFile(path.join(repo, "source.test.js"), tests, "utf8");
    await writeFile(path.join(repo, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(path.join(repo, "falsegreen.patch"), artifacts["falsegreen.patch"], "utf8");

    const initialized = spawnSync("git", ["init", "--quiet"], { cwd: repo, encoding: "utf8" });
    expect(initialized.status, initialized.stderr).toBe(0);

    const checked = spawnSync("git", ["apply", "--check", "falsegreen.patch"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(checked.status, checked.stderr).toBe(0);

    const applied = spawnSync("git", ["apply", "falsegreen.patch"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(applied.status, applied.stderr).toBe(0);

    const patchedTest = await readFile(
      path.join(repo, "source.regression.test.js"),
      "utf8",
    );
    expect(patchedTest).toBe(generated);

    const runner = createRunner(harness.config);
    const result = await runner.runTests({
      files: {
        "source.js": source,
        "source.test.js": `${tests}\n${patchedTest}`,
      },
      timeoutMs: 10000,
    });

    expect(result.outcome).toBe("completed");
    expect(result.counts).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0 });
    expect(result.tests.map((item) => item.name)).toContain(
      "grants standard access at exactly fifty",
    );
  }, 30000);
});
