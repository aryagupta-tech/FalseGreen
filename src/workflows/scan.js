/**
 * Durable workflow steps for the Workflow SDK (Vercel).
 *
 * Each step is one engine tick, so a resumed workflow never repeats a mutation
 * execution that already finished. The engine persists every step in the store;
 * the workflow only decides when to ask for the next one.
 */
import { sleep } from "workflow";
import { tickRepair, tickScan } from "../core/jobs/engine.js";
import { getRuntime } from "../lib/runtime.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function runScanWorkflow(runId) {
  "use workflow";

  for (;;) {
    const result = await scanStep(runId);
    if (result.done) return result;
    if (result.status === "queued") await sleep("1s");
  }
}

export async function runRepairWorkflow(runId) {
  "use workflow";

  for (;;) {
    const result = await repairStep(runId);
    if (result.done) return result;
    if (result.status === "queued") await sleep("1s");
  }
}

async function scanStep(runId) {
  "use step";

  const { store, config } = getRuntime();
  const run = await tickScan({ store, config, runId });
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    done: TERMINAL.has(run.status),
  };
}

async function repairStep(runId) {
  "use step";

  const { store, config } = getRuntime();
  const run = await tickRepair({ store, config, runId });
  const repair = run.repair;
  const done =
    TERMINAL.has(run.status) ||
    (repair && repair.status !== "queued" && repair.status !== "running");
  return { id: run.id, status: run.status, phase: run.phase, done };
}
