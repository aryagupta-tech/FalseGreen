import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FileStore } from "../src/core/store/index.js";
import { ConfigError, ConflictError, ValidationError } from "../src/core/errors.js";
import {
  createRun,
  enqueueScan,
  requestRepair,
  runKey,
  tickRepair,
  tickScan,
} from "../src/core/jobs/engine.js";
import { driveRun } from "../src/core/jobs/driver.js";
import { ARTIFACT_NAMES } from "../src/core/jobs/artifacts.js";

const SOURCE = `export function shippingFee(total) {
  return total >= 1000 ? 0 : 50;
}
`;

const TESTS = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("free shipping at exactly 1000", () => {
  expect(shippingFee(1000)).toBe(0);
});
`;

const PROPOSAL = {
  title: "gives free shipping at exactly 1000",
  exportName: "shippingFee",
  args: [1000],
  expected: 0,
  rationale: "The requirement says exactly 1000 ships free.",
};

const MUTATIONS = [
  {
    id: "m1",
    family: "boundary",
    operator: ">=",
    replacement: ">",
    start: 48,
    end: 50,
    line: 2,
    column: 18,
    before: SOURCE,
    after: SOURCE,
    change: ">= 1000 becomes > 1000",
  },
  {
    id: "m2",
    family: "comparison",
    operator: ">=",
    replacement: "<",
    start: 48,
    end: 50,
    line: 2,
    column: 18,
    before: SOURCE,
    after: SOURCE,
    change: ">= 1000 becomes < 1000",
  },
  {
    id: "m3",
    family: "equality",
    operator: "===",
    replacement: "!==",
    start: 60,
    end: 63,
    line: 2,
    column: 30,
    before: SOURCE,
    after: SOURCE,
    change: "=== 0 becomes !== 0",
  },
];

function testLimits(overrides = {}) {
  return {
    maxSourceBytes: 65536,
    maxTestsBytes: 65536,
    maxRequirementBytes: 4096,
    maxMutations: 12,
    maxActiveJobs: 2,
    maxModelAttempts: 2,
    testTimeoutMs: 1000,
    scanDeadlineMs: 10000,
    repairDeadlineMs: 10000,
    runTtlMs: 60000,
    maxRunsPerSessionPerHour: 20,
    maxArgsBytes: 4096,
    maxOutputBytes: 65536,
    pollIntervalMs: 10,
    ...overrides,
  };
}

function executionResult({
  outcome = "completed",
  total = 2,
  passed = 2,
  failed = 0,
  skipped = 0,
  durationMs = 5,
  exitCode = 0,
  error = null,
} = {}) {
  return {
    outcome,
    counts: { total, passed, failed, skipped },
    tests:
      failed > 0
        ? [
            {
              name: "proposed assertion",
              status: "failed",
              failureMessages: ["AssertionError: expected 50 to be 0"],
            },
          ]
        : [],
    durationMs,
    exitCode,
    error,
    logs: { stdout: "", stderr: "" },
  };
}

function applyMutation(source, mutation) {
  return `${source}\n// mutant:${mutation.id}`;
}

function createFakeRunner({ mutationResults = {}, baselineDelayMs = 0 } = {}) {
  const calls = [];
  const runTests = async ({ files, timeoutMs }) => {
    calls.push({ files, timeoutMs });
    const source = files["source.js"];
    const tests = files["source.test.js"];
    const mutant = /\/\/ mutant:(\w+)/.exec(source);
    const proposed = tests.includes("REGRESSION");

    if (!mutant) {
      if (baselineDelayMs) await new Promise((resolve) => setTimeout(resolve, baselineDelayMs));
      return executionResult({ total: proposed ? 3 : 2, passed: proposed ? 3 : 2 });
    }

    const id = mutant[1];
    const spec = mutationResults[id];
    if (typeof spec === "function") return spec({ proposed, source, tests });
    if (spec) return spec;

    return executionResult({
      total: proposed ? 3 : 2,
      passed: proposed ? 2 : 2,
      failed: proposed ? 1 : 0,
      exitCode: 1,
    });
  };
  return { runTests, calls };
}

function renderProposal(input, proposal) {
  const content = `// REGRESSION
import { expect, test } from "vitest";
import { ${proposal.exportName} } from "./source.js";

test(${JSON.stringify(proposal.title)}, () => {
  expect(shippingFee(1000)).toBe(0);
});
`;
  return {
    fileName: "source.regression.test.js",
    content,
    testName: proposal.title,
  };
}

function makeVerify(runner) {
  return async ({ source, tests, mutation, generatedTest }) => {
    const files = [
      { "source.js": source, "source.test.js": tests },
      { "source.js": applyMutation(source, mutation), "source.test.js": tests },
      { "source.js": source, "source.test.js": `${tests}\n${generatedTest}` },
      {
        "source.js": applyMutation(source, mutation),
        "source.test.js": `${tests}\n${generatedTest}`,
      },
    ];
    const [originalExisting, mutantExisting, originalProposed, mutantProposed] =
      await Promise.all(files.map((entry) => runner.runTests({ files: entry, timeoutMs: 500 })));

    const observed = (result) => {
      if (result.outcome === "timeout") return "timeout";
      if (result.outcome === "error") return "error";
      return Number(result.counts?.failed) > 0 ? "fail" : "pass";
    };

    const rows = [
      ["original-existing", "Original plus existing tests", "pass", originalExisting],
      ["mutant-existing", "Mutant plus existing tests", "pass", mutantExisting],
      ["original-proposed", "Original plus proposed test", "pass", originalProposed],
      ["mutant-proposed", "Mutant plus proposed test", "fail-proposed", mutantProposed],
    ].map(([id, label, expected, result]) => {
      const seen = observed(result);
      const passes =
        (expected === "pass" && seen === "pass") ||
        (expected === "fail-proposed" && seen === "fail");
      return {
        id,
        label,
        expected,
        observed: seen,
        status: passes ? "pass" : "fail",
        durationMs: result.durationMs,
        detail: result.error || null,
      };
    });

    const originalProposedRow = rows.find((row) => row.id === "original-proposed");
    if (originalProposedRow.status === "fail") {
      return {
        status: "mismatch",
        matrix: rows,
        mismatch: {
          requirement: "Shipping is free at exactly 1000.",
          args: [1000],
          expected: 0,
          observed: "different value",
          message: "The proposed test does not pass against the original implementation.",
        },
        detail: "The proposed test does not match the stated requirement.",
      };
    }

    return {
      status: rows.every((row) => row.status === "pass") ? "verified" : "rejected",
      matrix: rows,
      mismatch: null,
      detail: null,
    };
  };
}

function makeModel({ failFirst = 0, alwaysFail = false, proposal = PROPOSAL } = {}) {
  const inputs = [];
  const model = {
    async proposeTest(input) {
      inputs.push(input);
      if (alwaysFail || inputs.length <= failFirst) {
        throw new Error(`model attempt ${inputs.length} failed validation`);
      }
      return typeof proposal === "function" ? proposal(input) : proposal;
    },
    describe() {
      return { driver: "fake-openai", id: "fake-model-1" };
    },
  };
  return { model, inputs, createModel: () => model };
}

function makeDeps({ runner, model, verify } = {}) {
  const actualRunner = runner || createFakeRunner();
  const actualModel = model || makeModel();
  return {
    validateInput: () => ({
      ok: true,
      exports: [{ name: "shippingFee", kind: "function" }],
      mutationsAvailable: MUTATIONS.length,
    }),
    collectMutations: () => MUTATIONS.map((mutation) => ({ ...mutation })),
    applyMutation,
    createRunner: () => actualRunner,
    createModel: actualModel.createModel,
    renderProposal,
    verifyRepair: verify || makeVerify(actualRunner),
  };
}

function makeConfig(deps, overrides = {}) {
  return {
    limits: testLimits(overrides.limits),
    execution: { driver: "local" },
    store: {},
    model: { driver: "openai-compatible", id: "fake-model-1" },
    deps,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    requirement: "Shipping is free at exactly 1000.",
    source: SOURCE,
    tests: TESTS,
    ...overrides,
  };
}

async function completeScan(store, config, run) {
  await enqueueScan({ store, config, run, deps: config.deps, schedule: false });
  for (let i = 0; i < 30; i += 1) {
    const current = await store.get(runKey(run.id));
    if (current.status === "completed" || current.status === "failed") return current;
    await tickScan({ store, config, runId: run.id, deps: config.deps });
  }
  throw new Error("scan did not finish");
}

async function leaseHeld(store, slot) {
  const token = await store.acquireLease(`fg:lease:job:${slot}`, 1000);
  if (!token) return true;
  await store.releaseLease(`fg:lease:job:${slot}`, token);
  return false;
}

function defaultMutationResults() {
  return {
    m1: () => executionResult({ total: 2, passed: 1, failed: 1, exitCode: 0 }),
    m2: ({ proposed }) =>
      proposed
        ? executionResult({ total: 3, passed: 2, failed: 1, exitCode: 1 })
        : executionResult({ total: 2, passed: 2, failed: 0, exitCode: 1 }),
    m3: () => executionResult({ outcome: "timeout", total: 0, passed: 0, failed: 0, exitCode: null }),
  };
}

let dir;
let store;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-jobs-"));
  store = new FileStore({ fileDir: dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("createRun", () => {
  it("validates input and persists a queued run with null lifecycle fields", async () => {
    const config = makeConfig(makeDeps());
    const run = await createRun({
      store,
      limits: testLimits(),
      sessionId: "session-1",
      input: input(),
      deps: config.deps,
    });

    expect(run.id).toMatch(/^run_[a-z2-7]{12}$/);
    expect(run.status).toBe("queued");
    expect(run.phase).toBe("queued");
    expect(run.baseline).toBe(null);
    expect(run.mutations).toBe(null);
    expect(run.scan).toBe(null);
    expect(run.repair).toBe(null);
    expect(run.sessionId).toBe("session-1");
    expect(run.input.sourceName).toBe("source.js");
    expect(run.input.testName).toBe("source.test.js");
    expect(run.expiresAt).toBeGreaterThan(run.createdAt);

    const stored = await store.get(runKey(run.id));
    expect(stored).toEqual(run);
  });

  it("rejects invalid input with a ValidationError", async () => {
    const deps = {
      validateInput: () => ({
        ok: false,
        errors: [{ field: "source", code: "source_parse_error", message: "Bad source." }],
      }),
    };
    await expect(
      createRun({ store, limits: testLimits(), sessionId: "s", input: input(), deps }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("scan", () => {
  it("runs baseline and every mutation, classifying only from ExecutionResult", async () => {
    const runner = createFakeRunner({ mutationResults: defaultMutationResults() });
    const deps = makeDeps({ runner });
    const config = makeConfig(deps);
    const run = await createRun({
      store,
      limits: config.limits,
      sessionId: "s",
      input: input(),
      deps,
    });

    const finished = await completeScan(store, config, run);

    expect(finished.status).toBe("completed");
    expect(finished.phase).toBe("done");
    expect(finished.baseline.counts).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
    expect(finished.mutations.map((m) => [m.id, m.status])).toEqual([
      ["m1", "caught"],
      ["m2", "missed"],
      ["m3", "timeout"],
    ]);
    expect(finished.scan).toMatchObject({
      tested: 3,
      caught: 1,
      missed: 1,
      errors: 0,
      timeouts: 1,
      untested: 0,
      stopReason: "complete",
    });
    expect(finished.scan.durationMs).toBeGreaterThan(0);
    expect(await leaseHeld(store, 0)).toBe(false);
    expect(await leaseHeld(store, 1)).toBe(false);
  });

  it("stops after a failed baseline", async () => {
    const runner = createFakeRunner();
    runner.runTests = async () => executionResult({ total: 2, passed: 1, failed: 1 });
    const deps = makeDeps({ runner });
    const config = makeConfig(deps);
    const run = await createRun({
      store,
      limits: config.limits,
      sessionId: "s",
      input: input(),
      deps,
    });

    await enqueueScan({ store, config, run, deps, schedule: false });
    const finished = await tickScan({ store, config, runId: run.id, deps });

    expect(finished.status).toBe("completed");
    expect(finished.phase).toBe("done");
    expect(finished.scan.stopReason).toBe("baseline_failed");
    expect(finished.scan.tested).toBe(0);
    expect(finished.scan.untested).toBe(3);
    expect(finished.mutations.every((m) => m.status === "untested")).toBe(true);
    expect(await leaseHeld(store, 0)).toBe(false);
    expect(await leaseHeld(store, 1)).toBe(false);
  });

  it("stops when the baseline has zero tests", async () => {
    const runner = createFakeRunner();
    runner.runTests = async () => executionResult({ total: 0, passed: 0, failed: 0 });
    const deps = makeDeps({ runner });
    const config = makeConfig(deps);
    const run = await createRun({
      store,
      limits: config.limits,
      sessionId: "s",
      input: input(),
      deps,
    });

    await enqueueScan({ store, config, run, deps, schedule: false });
    const finished = await tickScan({ store, config, runId: run.id, deps });

    expect(finished.status).toBe("completed");
    expect(finished.scan.stopReason).toBe("no_tests");
    expect(finished.scan.tested).toBe(0);
    expect(finished.scan.untested).toBe(3);
  });

  it("marks remaining mutations untested when the deadline passes", async () => {
    const slow = ({ proposed }) => {
      void proposed;
      return executionResult({ total: 2, passed: 2, failed: 0, exitCode: 0 });
    };
    const runner = createFakeRunner({ mutationResults: { m1: slow, m2: slow, m3: slow } });
    const base = runner.runTests;
    runner.runTests = async (args) => {
      const result = await base(args);
      if (args.files["source.js"].includes("// mutant:")) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return result;
    };

    const deps = makeDeps({ runner });
    const config = makeConfig(deps);
    const run = await createRun({
      store,
      limits: config.limits,
      sessionId: "s",
      input: input(),
      deps,
    });
    const shortened = await store.get(runKey(run.id));
    shortened.deadlineAt = Date.now() + 150;
    await store.set(runKey(run.id), shortened, { ttlMs: 60000 });

    await enqueueScan({ store, config, run: shortened, deps, schedule: false });
    for (let i = 0; i < 30; i += 1) {
      const current = await store.get(runKey(run.id));
      if (current.status === "completed") break;
      await tickScan({ store, config, runId: run.id, deps });
    }

    const finished = await store.get(runKey(run.id));
    expect(finished.status).toBe("completed");
    expect(finished.scan.stopReason).toBe("deadline");
    expect(finished.scan.untested).toBeGreaterThan(0);
    expect(finished.scan.tested).toBeLessThan(3);
    expect(finished.mutations.filter((m) => m.status === "untested").length).toBe(
      finished.scan.untested,
    );
  });
});

describe("repair request", () => {
  async function completedRun(config) {
    const run = await createRun({
      store,
      limits: config.limits,
      sessionId: "s",
      input: input(),
      deps: config.deps,
    });
    return completeScan(store, config, run);
  }

  it("rejects a run that has not completed scanning", async () => {
    const config = makeConfig(makeDeps());
    const run = await createRun({
      store,
      limits: config.limits,
      sessionId: "s",
      input: input(),
      deps: config.deps,
    });
    await expect(
      requestRepair({ store, config, runId: run.id, mutationId: "m2", schedule: false }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects mutations that were not missed", async () => {
    const config = makeConfig(
      makeDeps({ runner: createFakeRunner({ mutationResults: defaultMutationResults() }) }),
    );
    const finished = await completedRun(config);
    await expect(
      requestRepair({ store, config, runId: finished.id, mutationId: "m1", schedule: false }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      requestRepair({ store, config, runId: finished.id, mutationId: "nope", schedule: false }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("requires a configured model", async () => {
    const config = makeConfig(
      makeDeps({ runner: createFakeRunner({ mutationResults: defaultMutationResults() }) }),
    );
    const finished = await completedRun(config);
    config.model = { driver: "unconfigured", id: "" };
    await expect(
      requestRepair({ store, config, runId: finished.id, mutationId: "m2", schedule: false }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("queues a repair and takes a job slot", async () => {
    const config = makeConfig(
      makeDeps({ runner: createFakeRunner({ mutationResults: defaultMutationResults() }) }),
    );
    const finished = await completedRun(config);
    const repaired = await requestRepair({
      store,
      config,
      runId: finished.id,
      mutationId: "m2",
      schedule: false,
    });

    expect(repaired.status).toBe("repairing");
    expect(repaired.phase).toBe("proposal");
    expect(repaired.repair).toMatchObject({
      mutationId: "m2",
      status: "queued",
      attempts: [],
      proposal: null,
      generatedTest: null,
      verification: null,
      artifacts: null,
    });
    expect(repaired.selectedMutationId).toBe("m2");
    expect(repaired.repairRequestedFor).toBe("m2");
    expect(repaired.jobLeaseToken).toBeTruthy();
    expect(await leaseHeld(store, repaired.jobSlot)).toBe(true);
  });
});

describe("repair tick", () => {
  async function completedRun(config) {
    const run = await createRun({
      store,
      limits: config.limits,
      sessionId: "s",
      input: input(),
      deps: config.deps,
    });
    return completeScan(store, config, run);
  }

  it("verifies a repair, builds artifacts, and the patch applies with git", async () => {
    const runner = createFakeRunner({ mutationResults: defaultMutationResults() });
    const deps = makeDeps({ runner });
    const config = makeConfig(deps);
    const finished = await completedRun(config);
    await requestRepair({ store, config, runId: finished.id, mutationId: "m2", schedule: false });

    const verified = await tickRepair({ store, config, runId: finished.id, deps });

    expect(verified.status).toBe("completed");
    expect(verified.phase).toBe("done");
    expect(verified.repair.status).toBe("verified");
    expect(verified.repair.proposal).toEqual(PROPOSAL);
    expect(verified.repair.attempts).toHaveLength(1);
    expect(verified.repair.attempts[0].error).toBe(null);
    expect(verified.repair.verification.status).toBe("verified");
    expect(verified.repair.verification.matrix).toHaveLength(4);
    expect(verified.repair.verification.matrix.map((row) => row.id)).toEqual([
      "original-existing",
      "mutant-existing",
      "original-proposed",
      "mutant-proposed",
    ]);
    expect(verified.repair.verification.matrix.every((row) => row.status === "pass")).toBe(true);
    expect(Object.keys(verified.repair.artifacts).sort()).toEqual([...ARTIFACT_NAMES].sort());
    expect(await leaseHeld(store, 0)).toBe(false);
    expect(await leaseHeld(store, 1)).toBe(false);

    const generated = verified.repair.artifacts["falsegreen.generated.test.js"];
    expect(generated).toBe(verified.repair.generatedTest);
    expect(generated).toContain("shippingFee");

    const evidence = JSON.parse(verified.repair.artifacts["falsegreen.evidence.json"]);
    expect(evidence.engineVersion).toBe("0.1.0");
    expect(evidence.runId).toBe(verified.id);
    expect(evidence.input.source).toBe(SOURCE);
    expect(evidence.input.tests).toBe(TESTS);
    expect(evidence.exports).toEqual([{ name: "shippingFee", kind: "function" }]);
    expect(evidence.mutations).toHaveLength(3);
    expect(evidence.mutations.map((m) => m.status)).toEqual(["caught", "missed", "timeout"]);
    expect(evidence.mutation.id).toBe("m2");
    expect(evidence.repair.generatedTest).toBe(generated);
    expect(evidence.repair.verification.matrix).toHaveLength(4);
    expect(evidence.model).toEqual({ driver: "fake-openai", id: "fake-model-1" });
    expect(evidence.limits.maxMutations).toBe(12);
    expect(JSON.stringify(evidence)).not.toContain("apiKey");
    expect(JSON.stringify(evidence)).not.toContain("MODEL_API_KEY");

    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "fg-patch-"));
    try {
      await fs.writeFile(path.join(repo, "source.js"), SOURCE);
      const patchFile = path.join(repo, "falsegreen.patch");
      await fs.writeFile(patchFile, verified.repair.artifacts["falsegreen.patch"]);
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["apply", "--check", patchFile], { cwd: repo });
      execFileSync("git", ["apply", patchFile], { cwd: repo });
      const applied = await fs.readFile(path.join(repo, "source.regression.test.js"), "utf8");
      expect(applied).toBe(generated);
    } finally {
      await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("persists a requirement mismatch and produces no artifacts", async () => {
    const matchMatrix = [
      {
        id: "original-existing",
        label: "Original plus existing tests",
        expected: "pass",
        observed: "pass",
        status: "pass",
        durationMs: 5,
        detail: null,
      },
      {
        id: "mutant-existing",
        label: "Mutant plus existing tests",
        expected: "pass",
        observed: "pass",
        status: "pass",
        durationMs: 5,
        detail: null,
      },
      {
        id: "original-proposed",
        label: "Original plus proposed test",
        expected: "pass",
        observed: "fail",
        status: "fail",
        durationMs: 5,
        detail: "AssertionError: expected 50 to be 0",
      },
      {
        id: "mutant-proposed",
        label: "Mutant plus proposed test",
        expected: "fail-proposed",
        observed: "fail",
        status: "pass",
        durationMs: 5,
        detail: null,
      },
    ];
    const verifyRepair = async () => ({
      status: "mismatch",
      matrix: matchMatrix,
      mismatch: {
        requirement: "Shipping is free at exactly 1000.",
        args: [1000],
        expected: 0,
        observed: 50,
        message: "AssertionError: expected 50 to be 0",
      },
      detail: "The proposed test does not pass against the original implementation.",
    });
    const deps = makeDeps({
      runner: createFakeRunner({ mutationResults: defaultMutationResults() }),
      verify: verifyRepair,
    });
    const config = makeConfig(deps);
    const finished = await completedRun(config);
    await requestRepair({ store, config, runId: finished.id, mutationId: "m2", schedule: false });

    const repaired = await tickRepair({ store, config, runId: finished.id, deps });

    expect(repaired.status).toBe("completed");
    expect(repaired.repair.status).toBe("mismatch");
    expect(repaired.repair.verification.status).toBe("mismatch");
    expect(repaired.repair.verification.mismatch.observed).toBe(50);
    expect(repaired.repair.verification.matrix).toHaveLength(4);
    expect(repaired.repair.artifacts).toBe(null);
    expect(repaired.repair.failure).toContain("does not pass");
    expect(await leaseHeld(store, 0)).toBe(false);
    expect(await leaseHeld(store, 1)).toBe(false);
  });

  it("retries the model with the previous attempt attached", async () => {
    const model = makeModel({ failFirst: 1 });
    const deps = makeDeps({
      runner: createFakeRunner({ mutationResults: defaultMutationResults() }),
      model,
    });
    const config = makeConfig(deps);
    const finished = await completedRun(config);
    await requestRepair({ store, config, runId: finished.id, mutationId: "m2", schedule: false });

    const repaired = await tickRepair({ store, config, runId: finished.id, deps });

    expect(repaired.repair.status).toBe("verified");
    expect(repaired.repair.attempts).toHaveLength(2);
    expect(repaired.repair.attempts[0].error).toContain("failed validation");
    expect(repaired.repair.attempts[1].proposal).toEqual(PROPOSAL);
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[1].previousAttempt.error).toContain("failed validation");
  });
});

describe("driveRun", () => {
  it("completes a run through the durable tick loop", async () => {
    const deps = makeDeps({
      runner: createFakeRunner({ mutationResults: defaultMutationResults() }),
    });
    const config = makeConfig(deps);
    const run = await createRun({
      store,
      limits: config.limits,
      sessionId: "s",
      input: input(),
      deps,
    });
    await enqueueScan({ store, config, run, deps, schedule: false });

    await driveRun({ store, config, runId: run.id });

    const finished = await store.get(runKey(run.id));
    expect(finished.status).toBe("completed");
    expect(finished.phase).toBe("done");
    expect(finished.scan.tested).toBe(3);
    expect(finished.scan.stopReason).toBe("complete");
  });

  it("persists an infrastructure failure and releases the slot", async () => {
    const deps = {
      ...makeDeps(),
      createRunner: () => {
        throw new Error("sandbox unavailable");
      },
    };
    const config = makeConfig(deps);
    const run = await createRun({
      store,
      limits: config.limits,
      sessionId: "s",
      input: input(),
      deps,
    });
    await enqueueScan({ store, config, run, deps, schedule: false });

    await driveRun({ store, config, runId: run.id });

    const failed = await store.get(runKey(run.id));
    expect(failed.status).toBe("failed");
    expect(failed.failure).toMatchObject({
      code: "internal_error",
      message: "sandbox unavailable",
    });
    expect(failed.jobSlot).toBe(null);
    expect(failed.jobLeaseToken).toBe(null);
    expect(await leaseHeld(store, 0)).toBe(false);
    expect(await leaseHeld(store, 1)).toBe(false);
  });
});
