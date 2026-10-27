import { tickRepair, tickScan, runKey } from "./engine.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistFailure(store, runId, error) {
  let run;
  try {
    run = await store.get(runKey(runId));
  } catch {
    return;
  }
  if (!run) return;

  run.status = "failed";
  run.failure = {
    code: error?.code || "internal_error",
    message: error?.message || "The run failed unexpectedly.",
  };
  run.updatedAt = Date.now();
  if (run.jobSlot != null && run.jobLeaseToken) {
    try {
      await store.releaseLease(`fg:lease:job:${run.jobSlot}`, run.jobLeaseToken);
    } catch {
      // The lease expires on its own.
    }
  }
  run.jobSlot = null;
  run.jobLeaseToken = null;
  try {
    const ttlMs = Number(run.expiresAt) ? Math.max(1, Number(run.expiresAt) - Date.now()) : undefined;
    await store.set(runKey(run.id), run, ttlMs ? { ttlMs } : undefined);
  } catch {
    // Nothing else can be persisted.
  }
}

async function loop({ store, config, runId }) {
  for (;;) {
    let run;
    try {
      run = await store.get(runKey(runId));
    } catch (error) {
      await persistFailure(store, runId, error);
      return;
    }
    if (!run) return;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;

    try {
      if (run.status === "repairing") {
        await tickRepair({ store, config, runId });
      } else if (run.status === "queued" || run.status === "running") {
        await tickScan({ store, config, runId });
      } else {
        return;
      }
    } catch (error) {
      if (error?.code === "conflict") {
        await delay(20);
        continue;
      }
      await persistFailure(store, runId, error);
      return;
    }

    // A queued run without a job slot is retrying; do not spin on it.
    let current = null;
    try {
      current = await store.get(runKey(runId));
    } catch {
      current = null;
    }
    await delay(current && current.status === "queued" && !current.jobLeaseToken ? 250 : 5);
  }
}

/**
 * Drive a run to a terminal state. With a platform `waitUntil` hook the loop is
 * handed to it; otherwise it runs in-process.
 */
export async function driveRun({ store, config, runId, waitUntil }) {
  const work = loop({ store, config, runId });
  if (typeof waitUntil === "function") {
    waitUntil(work);
    return;
  }
  return work;
}
