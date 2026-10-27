import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { createStore } from "../src/core/store/index.js";
import {
  cancelRun,
  createRun,
  enqueueScan,
  requestRepair,
  runKey,
  tickRepair,
  tickScan,
} from "../src/core/jobs/engine.js";
import { driveRun } from "../src/core/jobs/driver.js";
import { getPreset } from "../src/lib/presets.js";

const SOURCE = `export function shippingFee(orderTotal) {
  return orderTotal >= 1000 ? 0 : 99;
}
`;

const SLOW_SOURCE = `export function slow(n) {
  return n >= 10 ? 1 : 0;
}
`;

function slowTests(ms) {
  return `import { expect, test } from "vitest";
import { slow } from "./source.js";
test("waits", async () => {
  await new Promise((resolve) => setTimeout(resolve, ${ms}));
  expect(slow(50)).toBe(1);
});
`;
}

const fakeModel = {
  describe: () => ({ driver: "test-double", id: "test-double" }),
  proposeTest: async () => ({
    title: "gives free shipping at exactly 1000",
    exportName: "shippingFee",
    args: [1000],
    expected: 0,
    rationale: "The requirement includes the exact threshold.",
  }),
};

let dir;
let config;
let store;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "falsegreen-runtime-"));
  config = loadConfig({
    STORE_DRIVER: "file",
    FG_DATA_DIR: dir,
    EXECUTION_DRIVER: "local",
    MODEL_DRIVER: "openai-compatible",
    MODEL_API_BASE_URL: "http://127.0.0.1:9/v1",
    MODEL_API_KEY: "test",
    MODEL_ID: "test-double",
  });
  config.jobDriver = "inline";
  config.deps = { createModel: () => fakeModel };
  store = createStore(config);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function create(input) {
  return createRun({
    store,
    limits: config.limits,
    sessionId: "session-1",
    input,
  });
}

describe("runtime orchestration", () => {
  test("a verified repair records its terminal status in the evidence report", async () => {
    const preset = getPreset("missed-boundary");
    const run = await create({
      requirement: preset.requirement,
      source: preset.source,
      tests: preset.tests,
    });
    await enqueueScan({ store, config, run, schedule: false });

    let current = run;
    for (let i = 0; i < 20 && current.status !== "completed"; i += 1) {
      current = await tickScan({ store, config, runId: run.id });
    }
    expect(current.status).toBe("completed");

    const missed = current.mutations.find((mutation) => mutation.status === "missed");
    expect(missed).toBeTruthy();

    await requestRepair({
      store,
      limits: config.limits,
      config,
      runId: run.id,
      mutationId: missed.id,
      schedule: false,
    });

    current = await store.get(runKey(run.id));
    for (let i = 0; i < 20 && current.repair.status !== "verified"; i += 1) {
      current = await tickRepair({ store, config, runId: run.id });
    }

    expect(current.repair.status).toBe("verified");
    expect(current.repair.artifacts["falsegreen.generated.test.js"]).toContain(
      "expect(shippingFee(1000)).toBe(0);",
    );
    const evidence = JSON.parse(current.repair.artifacts["falsegreen.evidence.json"]);
    expect(evidence.repair.status).toBe("verified");
    expect(JSON.stringify(evidence)).not.toContain("test-double-secret");
    expect(JSON.stringify(evidence)).not.toMatch(/MODEL_API_KEY|Bearer /);
  });

  test("a suite where every test is skipped stops before mutations", async () => {
    const tests = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";
test.skip("never runs", () => {
  expect(shippingFee(1000)).toBe(0);
});
`;
    const run = await create({
      requirement: "Orders of 1000 or more ship free.",
      source: SOURCE,
      tests,
    });
    await enqueueScan({ store, config, run, schedule: false });

    let current = run;
    for (let i = 0; i < 10 && current.status !== "completed"; i += 1) {
      current = await tickScan({ store, config, runId: run.id });
    }
    expect(current.status).toBe("completed");
    expect(current.scan.stopReason).toBe("no_tests");
    expect(current.mutations.every((mutation) => mutation.status === "untested")).toBe(true);
  });

  test("cancellation marks a run stopped and releases its job slot", async () => {
    const run = await create({
      requirement: "Slow module.",
      source: SLOW_SOURCE,
      tests: slowTests(1200),
    });
    await enqueueScan({ store, config, run, schedule: false });

    const driving = driveRun({ store, config, runId: run.id });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const requested = await cancelRun({ store, runId: run.id });
    expect(["running", "cancelled"]).toContain(requested.status);
    await driving;

    const final = await store.get(runKey(run.id));
    expect(final.status).toBe("cancelled");
    expect(final.scan?.stopReason).toBe("cancelled");
    expect(await store.get(`fg:cancel:${run.id}`)).toBeNull();

    const slot = await store.acquireLease("fg:lease:job:0", 2000);
    const slot2 = await store.acquireLease("fg:lease:job:1", 2000);
    expect(Boolean(slot || slot2)).toBe(true);
    if (slot) await store.releaseLease("fg:lease:job:0", slot);
    if (slot2) await store.releaseLease("fg:lease:job:1", slot2);
  });

  test("never executes more than two runs at once and finishes all three", async () => {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await create({
        requirement: "Slow module.",
        source: SLOW_SOURCE,
        tests: slowTests(700),
      });
      await enqueueScan({ store, config, run, schedule: false });
      runs.push(run);
    }

    const drivers = runs.map((run) => driveRun({ store, config, runId: run.id }));
    let maxLeased = 0;
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const records = await Promise.all(runs.map((run) => store.get(runKey(run.id))));
      const leased = records.filter((record) => record?.jobLeaseToken).length;
      maxLeased = Math.max(maxLeased, leased);
    }
    await Promise.all(drivers);

    expect(maxLeased).toBeLessThanOrEqual(2);
    const records = await Promise.all(runs.map((run) => store.get(runKey(run.id))));
    expect(records.every((record) => record.status === "completed")).toBe(true);
    for (const run of runs) {
      expect(await store.get(`fg:cancel:${run.id}`)).toBeNull();
    }
  });
});
