#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/core/config.js";
import { createStore } from "../src/core/store/index.js";
import {
  createRun,
  enqueueScan,
  requestRepair,
  tickRepair,
  tickScan,
} from "../src/core/jobs/engine.js";
import { PRESETS } from "../src/lib/presets.js";

const INCLUSIVE_GENERATED = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("gives free shipping at exactly 1000", () => {
  expect(shippingFee(1000)).toBe(0);
});
`;

const STRICT_GENERATED = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("charges shipping at exactly 1000 when the rule is exclusive", () => {
  expect(shippingFee(1000)).toBe(99);
});
`;

const SCENARIOS = [
  { id: "missed-boundary", repair: true },
  { id: "covered-boundary", repair: false },
  { id: "requirement-mismatch", repair: true },
  { id: "strict-requirement", repair: true },
];

function isExclusiveRequirement(requirement) {
  const text = String(requirement ?? "");
  if (/(?:\bor more\b|\bat least\b|\band above\b|\bor higher\b)/i.test(text)) return false;
  return /\babove\b/i.test(text);
}

function exportNameOf(source) {
  const match = String(source ?? "").match(
    /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  );
  return match ? match[1] : "shippingFee";
}

export function createDemoModel() {
  return {
    describe: () => ({ driver: "demo-scripted", id: "demo-scripted" }),
    async proposeTest({ requirement, source }) {
      const exclusive = isExclusiveRequirement(requirement);
      return {
        title: exclusive
          ? "charges shipping at exactly 1000 when the rule is exclusive"
          : "gives free shipping at exactly 1000",
        exportName: exportNameOf(source),
        args: [1000],
        expected: exclusive ? 99 : 0,
        rationale: exclusive
          ? "The requirement says exactly 1,000 pays shipping, so 1,000 should return 99."
          : "The requirement includes 1,000, so 1,000 should return 0.",
      };
    },
  };
}

export async function createDemoConfig() {
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(), "falsegreen-demo-"));
  const base = loadConfig({});
  const config = {
    ...base,
    store: { ...base.store, driver: "file", fileDir },
    execution: { ...base.execution, driver: "local", keepLocalArtifacts: false },
    model: {
      ...base.model,
      driver: "demo-scripted",
      id: "demo-scripted",
      baseUrl: "",
      apiKey: "",
    },
    deps: { createModel: () => createDemoModel() },
  };
  return { config, fileDir };
}

function getPreset(id) {
  const preset = PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  return preset;
}

function terminalScan(run) {
  return run.status === "completed" || run.status === "failed";
}

function terminalRepair(run) {
  return run.status !== "repairing" || !run.repair;
}

export async function scanRun({ store, config, input }) {
  const deps = config.deps;
  let run = await createRun({
    store,
    limits: config.limits,
    sessionId: "demo",
    input,
    deps,
  });
  run = await enqueueScan({ store, config, run, deps, schedule: false });

  for (let tick = 0; tick < 100 && !terminalScan(run); tick += 1) {
    run = await tickScan({ store, config, runId: run.id, deps });
  }
  if (!terminalScan(run)) throw new Error("The scan did not reach a terminal state.");
  return run;
}

export async function repairRun({ store, config, runId, mutationId }) {
  const deps = config.deps;
  let run = await requestRepair({
    store,
    limits: config.limits,
    config,
    runId,
    mutationId,
    deps,
    schedule: false,
  });

  for (let tick = 0; tick < 100 && !terminalRepair(run); tick += 1) {
    run = await tickRepair({ store, config, runId, deps });
  }
  return run;
}

export async function runPreset({ store, config, id }) {
  const preset = getPreset(id);
  const input = {
    requirement: preset.requirement,
    source: preset.source,
    tests: preset.tests,
  };
  let run = await scanRun({ store, config, input });
  const missed = (run.mutations || []).find((mutation) => mutation.status === "missed");
  const shouldRepair = SCENARIOS.find((scenario) => scenario.id === id)?.repair;

  if (shouldRepair) {
    if (!missed) throw new Error(`Preset ${id} produced no missed mutation to repair.`);
    run = await repairRun({ store, config, runId: run.id, mutationId: missed.id });
  }

  return { preset, run };
}

function countText(counts) {
  if (!counts) return "no counts";
  return `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped of ${counts.total}`;
}

function mutationCounts(mutation) {
  if (!mutation.counts) return mutation.reason || "-";
  return `${mutation.counts.passed} passed, ${mutation.counts.failed} failed`;
}

function scenarioErrors(id, run) {
  const errors = [];
  const baseline = run.baseline;
  if (
    !baseline ||
    baseline.outcome !== "completed" ||
    !baseline.counts ||
    baseline.counts.total === 0 ||
    baseline.counts.failed !== 0
  ) {
    errors.push("baseline did not pass with at least one test");
  }

  const repair = run.repair;
  const boundary = (run.mutations || []).find((mutation) => mutation.family === "boundary");

  if (id === "missed-boundary") {
    if (!boundary || boundary.status !== "missed") {
      errors.push("boundary mutation was not missed");
    }
    if (!run.scan || run.scan.missed < 1) errors.push("scan reported no missed mutation");
    if (!repair || repair.status !== "verified") errors.push("repair was not verified");
    if (repair?.generatedTest !== INCLUSIVE_GENERATED) {
      errors.push("generated test is not the expected inclusive boundary test");
    }
    if (!repair?.artifacts) errors.push("verified repair produced no artifacts");
  }

  if (id === "covered-boundary") {
    if (!run.mutations || run.mutations.length === 0) errors.push("no mutations were collected");
    if ((run.mutations || []).some((mutation) => mutation.status !== "caught")) {
      errors.push("not every mutation was caught");
    }
    if (!run.scan || run.scan.missed !== 0) errors.push("scan reported a missed mutation");
    if (repair) errors.push("a repair was requested for a caught mutation");
  }

  if (id === "requirement-mismatch" || id === "strict-requirement") {
    if (!repair || repair.status !== "mismatch") errors.push("repair was not a requirement mismatch");
    const mismatch = repair?.verification?.mismatch;
    if (!mismatch) {
      errors.push("mismatch record is missing");
    } else {
      if (JSON.stringify(mismatch.args) !== "[1000]") errors.push("mismatch args are not [1000]");
      if (id === "requirement-mismatch") {
        if (mismatch.expected !== 0) errors.push("mismatch expected is not 0");
        if (mismatch.observed !== 99) errors.push("mismatch observed is not 99");
        if (repair.generatedTest !== INCLUSIVE_GENERATED) {
          errors.push("generated test is not the expected inclusive boundary test");
        }
      } else {
        if (mismatch.expected !== 99) errors.push("mismatch expected is not 99");
        if (mismatch.observed !== 0) errors.push("mismatch observed is not 0");
        if (repair.generatedTest !== STRICT_GENERATED) {
          errors.push("generated test is not the expected strict boundary test");
        }
      }
    }
  }

  return errors;
}

function artifactLines(repair) {
  if (!repair || !repair.artifacts) return ["  none"];
  return Object.entries(repair.artifacts).map(
    ([name, content]) => `  ${name.padEnd(34)} ${Buffer.byteLength(content, "utf8")} bytes`,
  );
}

function printScenario(index, id, preset, run, errors) {
  const scan = run.scan || {};
  const repair = run.repair;

  console.log("");
  console.log(`Scenario ${index}/${SCENARIOS.length}: ${id} - ${preset.label}`);
  console.log(`Requirement: ${preset.requirement}`);
  console.log(`Baseline: ${countText(run.baseline?.counts)} (${run.baseline?.durationMs ?? 0}ms)`);

  console.log("Mutations:");
  for (const mutation of run.mutations || []) {
    console.log(
      `  ${String(mutation.id).padEnd(3)} ${String(mutation.family).padEnd(10)} ` +
        `${mutation.operator} -> ${mutation.replacement}`.padEnd(18) +
        ` ${String(mutation.status).padEnd(8)} ${mutationCounts(mutation)}`,
    );
  }

  console.log(
    `Scan: ${scan.tested ?? 0} tested | ${scan.caught ?? 0} caught | ${scan.missed ?? 0} missed | ` +
      `${scan.errors ?? 0} errors | ${scan.timeouts ?? 0} timeouts | stop ${scan.stopReason ?? "n/a"}`,
  );

  if (!repair) {
    console.log("Repair: not requested");
    console.log("Matrix: none");
  } else {
    console.log(`Repair: ${repair.status}`);
    if (repair.verification?.mismatch) {
      const mismatch = repair.verification.mismatch;
      console.log(
        `Mismatch: args ${JSON.stringify(mismatch.args)} | expected ${JSON.stringify(mismatch.expected)} | observed ${JSON.stringify(mismatch.observed)}`,
      );
    }
    console.log("Matrix:");
    for (const row of repair.verification?.matrix || []) {
      console.log(
        `  ${row.id.padEnd(18)} expected ${String(row.expected).padEnd(13)} ` +
          `observed ${String(row.observed).padEnd(8)} ${row.status}`,
      );
    }
  }

  console.log("Artifacts:");
  for (const line of artifactLines(repair)) console.log(line);
  console.log(`Result: ${errors.length === 0 ? "PASS" : "FAIL"}`);
  for (const error of errors) console.log(`  - ${error}`);
}

export async function main() {
  const startedAt = Date.now();
  const { config, fileDir } = await createDemoConfig();
  const store = createStore(config);
  let scenarioErrorsTotal = 0;

  console.log("FalseGreen offline demo");
  console.log(`Store: file (${fileDir})`);
  console.log("Execution: local Vitest runner");
  console.log("Model: demo-scripted (deterministic stand-in, not a model)");
  console.log(
    "Production repairs use MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID; this demo calls no network.",
  );

  try {
    let index = 0;
    for (const scenario of SCENARIOS) {
      index += 1;
      try {
        const { preset, run } = await runPreset({ store, config, id: scenario.id });
        const errors = scenarioErrors(scenario.id, run);
        scenarioErrorsTotal += errors.length;
        printScenario(index, scenario.id, preset, run, errors);
      } catch (error) {
        scenarioErrorsTotal += 1;
        console.log("");
        console.log(`Scenario ${index}/${SCENARIOS.length}: ${scenario.id} - FAIL`);
        console.log(`  - ${error?.message || String(error)}`);
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log("");
    if (scenarioErrorsTotal === 0) {
      console.log(`Summary: ${SCENARIOS.length}/${SCENARIOS.length} scenarios matched expectations in ${elapsed}s.`);
    } else {
      console.log(`Summary: ${scenarioErrorsTotal} expectation failure(s) across ${SCENARIOS.length} scenarios in ${elapsed}s.`);
    }
    console.log("The demo model is a deterministic stand-in, not a model.");
    return scenarioErrorsTotal === 0 ? 0 : 1;
  } finally {
    await fs.rm(fileDir, { recursive: true, force: true }).catch(() => {});
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`Demo failed: ${error?.stack || error?.message || String(error)}`);
      process.exitCode = 1;
    });
}
