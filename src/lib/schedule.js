import { start } from "workflow/api";
import { runRepairWorkflow, runScanWorkflow } from "../workflows/scan.js";
import { driveRun } from "../core/jobs/driver.js";

/**
 * Start the driver for a run.
 *
 * - `vercel-workflow`: durable Workflow SDK run; each tick is a step.
 * - `inline`: in-process loop, used locally, in Docker, and as a fallback.
 *
 * A failed workflow start always falls back to the inline driver so a
 * submission is never abandoned because orchestration is misconfigured.
 */
export async function scheduleRun({ kind, store, config, runId, after }) {
  const workflow = kind === "repair" ? runRepairWorkflow : runScanWorkflow;

  if (config.jobDriver === "vercel-workflow") {
    try {
      await start(workflow, [runId]);
      return;
    } catch (error) {
      console.error(
        "[falsegreen] Workflow start failed; using inline driver:",
        error?.message ?? error,
      );
    }
  }

  const task = () =>
    driveRun({ store, config, runId }).catch((error) => {
      console.error("[falsegreen] Run driver stopped:", error?.message ?? error);
    });

  if (typeof after === "function") {
    try {
      after(task);
      return;
    } catch {
      // Called outside a request scope; fall through to a detached task.
    }
  }
  queueMicrotask(task);
}
