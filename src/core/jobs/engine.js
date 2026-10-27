import { randomBytes } from "node:crypto";
import {
  ConfigError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../errors.js";
import { buildArtifacts, ENGINE_VERSION } from "./artifacts.js";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_REPAIR_STATUSES = new Set([
  "verified",
  "mismatch",
  "rejected",
  "error",
  "timeout",
]);
const ACTIVE_REPAIR_STATUSES = new Set(["queued", "running"]);

const DEP_LOADERS = {
  validateInput: async () => (await import("../validate-input.js")).validateInput,
  collectMutations: async () => (await import("../mutations.js")).collectMutations,
  applyMutation: async () => (await import("../mutations.js")).applyMutation,
  createRunner: async () => (await import("../execution/index.js")).createRunner,
  createModel: async () => (await import("../model/index.js")).createModel,
  renderProposal: async () => (await import("../model/index.js")).renderProposal,
  verifyRepair: async () => (await import("../verify.js")).verifyRepair,
};

async function resolveDeps(config, provided, needed) {
  const merged = { ...(config?.deps || {}), ...(provided || {}) };
  for (const name of needed) {
    if (!merged[name]) {
      const loader = DEP_LOADERS[name];
      if (!loader) continue;
      merged[name] = await loader();
    }
  }
  return merged;
}

async function ensureDep(resolved, config, deps, name) {
  if (typeof resolved[name] === "function") return resolved[name];
  const loaded = await resolveDeps(config, deps, [name]);
  resolved[name] = loaded[name];
  return resolved[name];
}

export function runKey(runId) {
  return `fg:run:${runId}`;
}

function jobLeaseName(slot) {
  return `fg:lease:job:${slot}`;
}

function lockName(runId) {
  return `fg:lock:run:${runId}`;
}

function generateRunId() {
  const bytes = randomBytes(12);
  let id = "";
  for (let i = 0; i < 12; i += 1) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return `run_${id}`;
}

const DEFAULT_LIMITS = {
  maxMutations: 12,
  maxActiveJobs: 2,
  maxModelAttempts: 2,
  testTimeoutMs: 10000,
  scanDeadlineMs: 180000,
  repairDeadlineMs: 120000,
  runTtlMs: 86400000,
};

function limitsOf(config) {
  return { ...DEFAULT_LIMITS, ...(config?.limits || {}) };
}

async function saveRun(store, run) {
  run.updatedAt = Date.now();
  const ttlMs = Number(run.expiresAt) ? Math.max(1, Number(run.expiresAt) - Date.now()) : undefined;
  await store.set(runKey(run.id), run, ttlMs ? { ttlMs } : undefined);
  return run;
}

function pushStep(run, key, status, ms, detail = null) {
  if (!Array.isArray(run.steps)) run.steps = [];
  run.steps.push({ at: Date.now(), key, status, ms: Math.max(0, Math.round(ms || 0)), detail });
  if (run.steps.length > 200) run.steps = run.steps.slice(-200);
}

async function releaseSlot(store, run) {
  if (run.jobSlot != null && run.jobLeaseToken) {
    await store.releaseLease(jobLeaseName(run.jobSlot), run.jobLeaseToken);
  }
  run.jobSlot = null;
  run.jobLeaseToken = null;
}

async function acquireSlot(store, limits, ttlMs) {
  const count = Math.max(1, Number(limits.maxActiveJobs) || 1);
  for (let slot = 0; slot < count; slot += 1) {
    const token = await store.acquireLease(jobLeaseName(slot), ttlMs);
    if (token) return { slot, token };
  }
  return null;
}

function normalizeMutations(rawMutations) {
  return (rawMutations || []).map((mutation, index) => ({
    ...mutation,
    id: mutation.id || `m${index + 1}`,
    status: "untested",
    durationMs: null,
    counts: null,
    reason: null,
  }));
}

async function ensureMutations(store, run, limits, deps) {
  if (Array.isArray(run.mutations)) return run.mutations;
  const collected = await deps.collectMutations(run.input.source, limits);
  run.mutations = normalizeMutations(collected);
  await saveRun(store, run);
  return run.mutations;
}

/**
 * Validate a new submission and persist a queued run record.
 */
export async function createRun({ store, limits, sessionId, input, deps }) {
  const resolved = await resolveDeps(null, deps, ["validateInput"]);
  const validation = await resolved.validateInput(input, limits);

  if (!validation || validation.ok !== true) {
    const errors = validation?.errors || [
      { field: "source", code: "invalid_input", message: "The submission is invalid." },
    ];
    const first = errors[0] || {};
    throw new ValidationError(first.message || "The submission is invalid.", { errors });
  }

  const now = Date.now();
  const run = {
    id: generateRunId(),
    sessionId: sessionId ?? null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + (Number(limits?.runTtlMs) || DEFAULT_LIMITS.runTtlMs),
    status: "queued",
    phase: "queued",
    deadlineAt: now + (Number(limits?.scanDeadlineMs) || DEFAULT_LIMITS.scanDeadlineMs),
    input: {
      requirement: input.requirement,
      source: input.source,
      tests: input.tests,
      sourceName: "source.js",
      testName: "source.test.js",
    },
    exports: validation.exports || [],
    baseline: null,
    mutations: null,
    scan: null,
    selectedMutationId: null,
    repairRequestedFor: null,
    repair: null,
    steps: [],
    failure: null,
    jobSlot: null,
    jobLeaseToken: null,
  };

  await saveRun(store, run);
  return run;
}

async function scheduleDrive({ store, config, runId, deps, schedule }) {
  if (schedule === false) return;
  const drive = deps?.driveRun;
  const invoke = async () => {
    if (drive) return drive({ store, config, runId });
    const { driveRun } = await import("./driver.js");
    return driveRun({ store, config, runId });
  };
  Promise.resolve()
    .then(invoke)
    .catch(() => {});
}

/**
 * Collect mutations, take a global job slot when one is free, and mark queued.
 */
export async function enqueueScan({ store, config, run, deps, schedule = true }) {
  const limits = limitsOf(config);
  const resolved = await resolveDeps(config, deps, []);
  const current = await store.get(runKey(run.id));
  if (!current) throw new NotFoundError();

  if (TERMINAL_RUN_STATUSES.has(current.status)) return current;
  if (current.status === "repairing") return current;

  if (!Array.isArray(current.mutations)) {
    await ensureDep(resolved, config, deps, "collectMutations");
  }
  await ensureMutations(store, current, limits, resolved);

  if (!current.jobLeaseToken) {
    const lease = await acquireSlot(
      store,
      limits,
      Math.max(1, Number(current.deadlineAt) - Date.now()) + 30000,
    );
    if (lease) {
      current.jobSlot = lease.slot;
      current.jobLeaseToken = lease.token;
    }
  }

  current.status = "queued";
  current.phase = "queued";
  await saveRun(store, current);
  await scheduleDrive({ store, config, runId: current.id, deps: resolved, schedule });
  return current;
}

function classifyMutation(result) {
  if (!result || result.outcome === "timeout") {
    return { status: "timeout", reason: "The mutant run timed out." };
  }
  if (result.outcome === "error") {
    return { status: "error", reason: result.error || "The mutant run could not execute." };
  }
  if (result.outcome === "completed") {
    const failed = Number(result.counts?.failed) || 0;
    return failed > 0
      ? { status: "caught", reason: null }
      : { status: "missed", reason: null };
  }
  return { status: "error", reason: "The mutant run returned an unknown outcome." };
}

function computeScan(run, stopReason) {
  const counts = {
    tested: 0,
    caught: 0,
    missed: 0,
    errors: 0,
    timeouts: 0,
    untested: 0,
    durationMs: Math.max(0, Math.round(Number(run.baseline?.durationMs) || 0)),
    stopReason,
  };

  for (const mutation of run.mutations || []) {
    counts.durationMs += Math.max(0, Math.round(Number(mutation.durationMs) || 0));
    switch (mutation.status) {
      case "caught":
        counts.tested += 1;
        counts.caught += 1;
        break;
      case "missed":
        counts.tested += 1;
        counts.missed += 1;
        break;
      case "error":
        counts.tested += 1;
        counts.errors += 1;
        break;
      case "timeout":
        counts.tested += 1;
        counts.timeouts += 1;
        break;
      default:
        counts.untested += 1;
        break;
    }
  }
  return counts;
}

async function finalizeScan(store, run, stopReason, detail = null) {
  run.scan = computeScan(run, stopReason);
  run.status = "completed";
  run.phase = "done";
  pushStep(run, "finalize", "done", 0, detail || stopReason);
  await releaseSlot(store, run);
  await saveRun(store, run);
  return run;
}

async function runTests(runner, files, timeoutMs, signal) {
  try {
    const result = await runner.runTests({ files, timeoutMs, signal });
    if (!result || !result.outcome) {
      return {
        outcome: "error",
        counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
        tests: [],
        durationMs: 0,
        exitCode: null,
        error: "The runner returned no result.",
        logs: { stdout: "", stderr: "" },
      };
    }
    return result;
  } catch (error) {
    return {
      outcome: "error",
      counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
      tests: [],
      durationMs: 0,
      exitCode: null,
      error: error?.message || "The runner failed.",
      logs: { stdout: "", stderr: "" },
    };
  }
}

async function disposeRunner(runner) {
  try {
    if (runner && typeof runner.dispose === "function") await runner.dispose();
    else if (runner && typeof runner.close === "function") await runner.close();
  } catch {
    // Cleanup is best effort; the runner already removes its throwaway directory.
  }
}

async function tickScanLocked(store, config, runId, resolved) {
  const limits = limitsOf(config);
  const run = await store.get(runKey(runId));
  if (!run) throw new NotFoundError();

  if (await store.get(cancelKey(runId))) {
    return finalizeCancel(store, run);
  }

  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    if (run.jobLeaseToken) {
      await releaseSlot(store, run);
      await saveRun(store, run);
    }
    return run;
  }
  if (run.status === "repairing") return run;

  if (!run.jobLeaseToken) {
    const lease = await acquireSlot(
      store,
      limits,
      Math.max(1, Number(run.deadlineAt) - Date.now()) + 30000,
    );
    if (!lease) {
      run.status = "queued";
      await saveRun(store, run);
      return run;
    }
    run.jobSlot = lease.slot;
    run.jobLeaseToken = lease.token;
  }

  if (run.phase === "queued") {
    run.status = "running";
    run.phase = "baseline";
    await saveRun(store, run);
  }

  if (Date.now() >= Number(run.deadlineAt)) {
    return finalizeScan(store, run, "deadline", "The scan deadline passed.");
  }

  if (run.phase === "baseline") {
    await ensureMutations(store, run, limits, resolved);
    const remaining = Math.max(1, Number(run.deadlineAt) - Date.now());
    const timeoutMs = Math.max(1, Math.min(Number(limits.testTimeoutMs) || 10000, remaining));
    const runner = await resolved.createRunner(config);
    let result;
    try {
      result = await runTests(
        runner,
        { "source.js": run.input.source, "source.test.js": run.input.tests },
        timeoutMs,
      );
    } finally {
      await disposeRunner(runner);
    }

    run.baseline = result;
    const total = Number(result.counts?.total) || 0;
    const failed = Number(result.counts?.failed) || 0;
    const skipped = Number(result.counts?.skipped) || 0;
    // A suite of only skipped tests executes nothing; it cannot protect anything.
    const executed = Math.max(0, total - skipped);

    if (result.outcome === "completed" && executed > 0 && failed === 0) {
      run.status = "running";
      run.phase = "mutations";
      pushStep(run, "baseline", "done", result.durationMs, `${total} tests pass`);
      await saveRun(store, run);
      return run;
    }

    const stopReason =
      result.outcome === "completed" && executed === 0 ? "no_tests" : "baseline_failed";
    pushStep(run, "baseline", "failed", result.durationMs, result.error || stopReason);
    return finalizeScan(store, run, stopReason, result.error || null);
  }

  if (run.phase === "mutations") {
    await ensureMutations(store, run, limits, resolved);
    const mutation = (run.mutations || []).find((item) => item.status === "untested");
    if (!mutation) {
      const stopReason = (run.mutations || []).length === 0 ? "no_mutations" : "complete";
      return finalizeScan(store, run, stopReason);
    }

    const remaining = Number(run.deadlineAt) - Date.now();
    if (remaining <= 0) {
      return finalizeScan(store, run, "deadline", "The scan deadline passed.");
    }

    let mutantSource;
    try {
      mutantSource = resolved.applyMutation(run.input.source, mutation);
    } catch (error) {
      mutation.status = "error";
      mutation.durationMs = 0;
      mutation.counts = null;
      mutation.reason = error?.message || "The mutation could not be applied.";
      pushStep(run, `mutation:${mutation.id}`, "failed", 0, mutation.reason);
      await saveRun(store, run);
      return run;
    }

    const runner = await resolved.createRunner(config);
    let result;
    try {
      result = await runTests(
        runner,
        { "source.js": mutantSource, "source.test.js": run.input.tests },
        Math.max(1, Math.min(Number(limits.testTimeoutMs) || 10000, remaining)),
      );
    } finally {
      await disposeRunner(runner);
    }

    const classified = classifyMutation(result);
    mutation.status = classified.status;
    mutation.durationMs = Math.max(0, Math.round(Number(result.durationMs) || 0));
    mutation.counts = result.counts || null;
    mutation.reason = classified.reason || result.error || null;
    pushStep(
      run,
      `mutation:${mutation.id}`,
      mutation.status === "error" ? "failed" : "done",
      mutation.durationMs,
      mutation.status,
    );
    await saveRun(store, run);
    return run;
  }

  return finalizeScan(store, run, "complete");
}

export async function tickScan({ store, config, runId, deps }) {
  const limits = limitsOf(config);
  const run = await store.get(runKey(runId));
  if (!run) throw new NotFoundError();
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    if (run.jobLeaseToken) {
      await releaseSlot(store, run);
      await saveRun(store, run);
    }
    return run;
  }
  if (run.status === "repairing") return run;

  const needed = ["createRunner", "applyMutation"];
  if (!Array.isArray(run.mutations)) needed.push("collectMutations");
  const resolved = await resolveDeps(config, deps, needed);

  const ttl = Math.max(
    15000,
    Math.max(1, Number(run.deadlineAt) - Date.now()) + 30000,
  );
  try {
    return await store.withLock(lockName(runId), ttl, async () => {
      if (run.phase === "mutations") {
        await ensureDep(resolved, config, deps, "applyMutation");
      }
      return tickScanLocked(store, config, runId, resolved);
    });
  } catch (error) {
    if (error instanceof ConflictError || error?.code === "conflict") {
      return (await store.get(runKey(runId))) || run;
    }
    await releaseAfterError(store, runId);
    throw error;
  }
}

async function releaseAfterError(store, runId) {
  try {
    const run = await store.get(runKey(runId));
    if (run && run.jobLeaseToken) {
      await releaseSlot(store, run);
      await saveRun(store, run);
    }
  } catch {
    // The lease expires on its own.
  }
}

function requireModel(config) {
  const driver = config?.model?.driver;
  if (!driver || driver === "unconfigured") {
    throw new ConfigError("Set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID to use repair.");
  }
}

function newRepair(mutationId, now) {
  return {
    mutationId,
    status: "queued",
    attempts: [],
    proposal: null,
    generatedTest: null,
    verification: null,
    artifacts: null,
    failure: null,
    durationMs: 0,
    startedAt: now,
    finishedAt: null,
  };
}

/**
 * Queue a repair for one missed mutation. A new request replaces a finished
 * repair; it never runs while another repair is queued or running.
 */
export async function requestRepair({ store, limits, config, runId, mutationId, deps, schedule = true }) {
  const effectiveLimits = { ...limitsOf(config), ...(limits || {}) };
  requireModel(config);

  const token = await store.acquireLease(lockName(runId), 15000);
  if (!token) throw new ConflictError("This run is busy. Try again.");
  try {
    const run = await store.get(runKey(runId));
    if (!run) throw new NotFoundError();

    if (run.status !== "completed") {
      throw new ConflictError("The run must finish scanning before a repair is requested.");
    }

    const mutation = (run.mutations || []).find((item) => item.id === mutationId);
    if (!mutation || mutation.status !== "missed") {
      throw new ConflictError("Only a missed mutation can be repaired.", {
        mutationId,
        status: mutation?.status ?? "unknown",
      });
    }

    if (run.repair && ACTIVE_REPAIR_STATUSES.has(run.repair.status)) {
      throw new ConflictError("A repair is already running for this run.");
    }

    const lease = await acquireSlot(
      store,
      effectiveLimits,
      (Number(effectiveLimits.repairDeadlineMs) || DEFAULT_LIMITS.repairDeadlineMs) + 30000,
    );
    if (!lease) throw new ConflictError("All job slots are busy. Try again.");

    await releaseSlot(store, run);
    run.jobSlot = lease.slot;
    run.jobLeaseToken = lease.token;

    const now = Date.now();
    run.selectedMutationId = mutationId;
    run.repairRequestedFor = mutationId;
    run.status = "repairing";
    run.phase = "proposal";
    run.repair = newRepair(mutationId, now);
    run.repairDeadlineAt =
      now + (Number(effectiveLimits.repairDeadlineMs) || DEFAULT_LIMITS.repairDeadlineMs);
    run.failure = null;

    await saveRun(store, run);
    const resolved = await resolveDeps(config, deps, []);
    await scheduleDrive({ store, config, runId, deps: resolved, schedule });
    return run;
  } finally {
    await store.releaseLease(lockName(runId), token);
  }
}

function proposalInput(run, mutation, previousAttempt) {
  return {
    requirement: run.input.requirement,
    source: run.input.source,
    tests: run.input.tests,
    mutation,
    execution: {
      baseline: run.baseline,
      mutant: {
        id: mutation.id,
        change: mutation.change,
        status: mutation.status,
        counts: mutation.counts,
        durationMs: mutation.durationMs,
        reason: mutation.reason,
      },
    },
    previousAttempt,
  };
}

async function terminateRepair(store, run, status, detail = null) {
  const now = Date.now();
  run.repair.status = status;
  run.repair.finishedAt = run.repair.finishedAt ?? now;
  run.repair.durationMs = Math.max(
    0,
    run.repair.finishedAt - (Number(run.repair.startedAt) || run.repair.finishedAt),
  );
  if (detail && status !== "verified") run.repair.failure = detail;
  run.status = "completed";
  run.phase = "done";
  pushStep(run, "repair", status === "verified" ? "done" : "failed", run.repair.durationMs, status);
  await releaseSlot(store, run);
  await saveRun(store, run);
  return run;
}

async function tickRepairLocked(store, config, runId, resolved, deps) {
  const limits = limitsOf(config);
  const run = await store.get(runKey(runId));
  if (!run) throw new NotFoundError();

  if (await store.get(cancelKey(runId))) {
    return finalizeCancel(store, run);
  }

  if (run.status !== "repairing" || !run.repair) {
    if (run.jobLeaseToken && TERMINAL_RUN_STATUSES.has(run.status)) {
      await releaseSlot(store, run);
      await saveRun(store, run);
    }
    return run;
  }

  const repair = run.repair;
  if (TERMINAL_REPAIR_STATUSES.has(repair.status)) {
    if (run.status !== "completed") {
      run.status = "completed";
      run.phase = "done";
    }
    await releaseSlot(store, run);
    await saveRun(store, run);
    return run;
  }

  if (!run.jobLeaseToken) {
    const lease = await acquireSlot(
      store,
      limits,
      (Number(limits.repairDeadlineMs) || DEFAULT_LIMITS.repairDeadlineMs) + 30000,
    );
    if (!lease) return run;
    run.jobSlot = lease.slot;
    run.jobLeaseToken = lease.token;
  }

  const startedAt = Number(repair.startedAt) || Date.now();
  const repairDeadlineAt =
    Number(run.repairDeadlineAt) ||
    startedAt + (Number(limits.repairDeadlineMs) || DEFAULT_LIMITS.repairDeadlineMs);
  if (Date.now() >= repairDeadlineAt) {
    return terminateRepair(store, run, "timeout", "The repair deadline passed.");
  }

  const mutation = (run.mutations || []).find((item) => item.id === repair.mutationId);
  if (!mutation) {
    return terminateRepair(store, run, "error", "The selected mutation no longer exists.");
  }

  const maxAttempts = Math.max(1, Number(limits.maxModelAttempts) || 1);

  if (!repair.proposal) {
    const createModel = await ensureDep(resolved, config, deps, "createModel");
    const model = await createModel(config);
    if (typeof model.describe === "function") {
      try {
        repair.modelInfo = model.describe();
      } catch {
        repair.modelInfo = null;
      }
    }
    while (!repair.proposal && repair.attempts.length < maxAttempts) {
      const previous = repair.attempts.length
        ? repair.attempts[repair.attempts.length - 1]
        : null;
      const attemptStarted = Date.now();
      try {
        const proposal = await model.proposeTest(
          proposalInput(run, mutation, previous),
        );
        repair.attempts.push({
          index: repair.attempts.length,
          proposal,
          error: null,
          durationMs: Math.max(0, Date.now() - attemptStarted),
        });
        repair.proposal = proposal;
      } catch (error) {
        repair.attempts.push({
          index: repair.attempts.length,
          proposal: null,
          error: error?.message || "The model did not return a valid proposal.",
          durationMs: Math.max(0, Date.now() - attemptStarted),
        });
      }
      await saveRun(store, run);
    }

    if (!repair.proposal) {
      const last = repair.attempts[repair.attempts.length - 1];
      return terminateRepair(
        store,
        run,
        "error",
        last?.error || "No valid proposal was produced.",
      );
    }

    try {
      const renderProposal = await ensureDep(resolved, config, deps, "renderProposal");
      const rendered = await renderProposal(
        {
          requirement: run.input.requirement,
          source: run.input.source,
          tests: run.input.tests,
          mutation,
          exports: run.exports,
        },
        repair.proposal,
      );
      repair.generatedTest = rendered.content;
      repair.generatedTestName = rendered.testName || null;
      repair.generatedTestFile = rendered.fileName || "source.regression.test.js";
    } catch (error) {
      return terminateRepair(
        store,
        run,
        "error",
        error?.message || "The proposed test could not be rendered.",
      );
    }

    repair.status = "running";
    run.phase = "verification";
    await saveRun(store, run);
  }

  if (!repair.verification) {
    const createRunner = await ensureDep(resolved, config, deps, "createRunner");
    const verifyRepair = await ensureDep(resolved, config, deps, "verifyRepair");
    const runner = await createRunner(config);
    let verification;
    try {
      verification = await verifyRepair({
        proposal: repair.proposal,
        generatedTest: repair.generatedTest,
        run: (args) => runner.runTests(args),
        source: run.input.source,
        tests: run.input.tests,
        mutation,
        requirement: run.input.requirement,
      });
    } catch (error) {
      verification = {
        status: "error",
        matrix: [],
        mismatch: null,
        detail: error?.message || "Verification failed.",
      };
    } finally {
      await disposeRunner(runner);
    }

    const status = verification?.status || "error";
    repair.verification = {
      status,
      matrix: Array.isArray(verification?.matrix) ? verification.matrix : [],
      mismatch: verification?.mismatch ?? null,
      detail: verification?.detail ?? null,
    };
    await saveRun(store, run);

    if (status === "verified") {
      try {
        const modelInfo = repair.modelInfo || {
          driver: config?.model?.driver ?? null,
          id: config?.model?.id ?? null,
        };
        const finishedAt = Date.now();
        repair.finishedAt = finishedAt;
        repair.durationMs = Math.max(0, finishedAt - (Number(repair.startedAt) || finishedAt));
        // Evidence must describe the terminal state, not the in-flight one.
        repair.status = "verified";
        repair.artifacts = buildArtifacts({
          run,
          repair,
          mutation,
          config,
          modelInfo,
          now: finishedAt,
        });
        return terminateRepair(store, run, "verified");
      } catch (error) {
        return terminateRepair(
          store,
          run,
          "error",
          error?.message || "The repair artifacts could not be built.",
        );
      }
    }

    if (status === "mismatch") {
      return terminateRepair(store, run, "mismatch", repair.verification.detail);
    }
    if (status === "rejected") {
      return terminateRepair(store, run, "rejected", repair.verification.detail);
    }
    return terminateRepair(store, run, "error", repair.verification.detail);
  }

  if (repair.verification.status === "verified") {
    return terminateRepair(store, run, "verified");
  }
  if (repair.verification.status === "mismatch") {
    return terminateRepair(store, run, "mismatch", repair.verification.detail);
  }
  if (repair.verification.status === "rejected") {
    return terminateRepair(store, run, "rejected", repair.verification.detail);
  }
  return terminateRepair(store, run, "error", repair.verification.detail);
}

export async function tickRepair({ store, config, runId, deps }) {
  const limits = limitsOf(config);
  const resolved = await resolveDeps(config, deps, []);
  const run = await store.get(runKey(runId));
  if (!run) throw new NotFoundError();

  const ttl = Math.max(
    15000,
    (Number(limits.repairDeadlineMs) || DEFAULT_LIMITS.repairDeadlineMs) + 30000,
  );
  try {
    return await store.withLock(lockName(runId), ttl, () =>
      tickRepairLocked(store, config, runId, resolved, deps),
    );
  } catch (error) {
    if (error instanceof ConflictError || error?.code === "conflict") {
      return (await store.get(runKey(runId))) || run;
    }
    await releaseAfterError(store, runId);
    throw error;
  }
}

function cancelKey(runId) {
  return `fg:cancel:${runId}`;
}

async function finalizeCancel(store, run) {
  const now = Date.now();
  run.status = "cancelled";
  run.phase = "done";
  run.updatedAt = now;

  if (
    run.repair &&
    (run.repair.status === "queued" || run.repair.status === "running")
  ) {
    run.repair.status = "cancelled";
    run.repair.finishedAt = now;
    run.repair.durationMs = Math.max(
      0,
      now - (Number(run.repair.startedAt) || now),
    );
    run.repair.failure = "Cancelled by the owner.";
  }
  if (!run.scan) {
    const untested = (run.mutations || []).filter((m) => m.status === "untested").length;
    run.scan = {
      tested: 0,
      caught: 0,
      missed: 0,
      errors: 0,
      timeouts: 0,
      untested,
      durationMs: Math.max(0, now - (Number(run.createdAt) || now)),
      stopReason: "cancelled",
    };
  } else if (!run.scan.stopReason) {
    run.scan.stopReason = "cancelled";
  }
  for (const mutation of run.mutations || []) {
    if (mutation.status === "untested" && !mutation.reason) {
      mutation.reason = "The scan was cancelled.";
    }
  }
  pushStep(run, "cancel", "done", 0, "Cancelled by the owner.");
  await store.delete(cancelKey(run.id));
  await releaseSlot(store, run);
  await saveRun(store, run);
  return run;
}

/**
 * Request cancellation. A step already executing cannot be interrupted, so the
 * flag is durable: the next tick observes it, releases the job slot, and marks
 * the run cancelled. A free run is cancelled immediately.
 */
export async function cancelRun({ store, runId }) {
  await store.set(cancelKey(runId), { at: Date.now() }, { ttlMs: 60 * 60 * 1000 });

  try {
    return await store.withLock(lockName(runId), 1500, async () => {
      const run = await store.get(runKey(runId));
      if (!run) throw new NotFoundError();
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        await store.delete(cancelKey(runId));
        return run;
      }
      return finalizeCancel(store, run);
    });
  } catch (error) {
    if (error?.code === "conflict") {
      const run = await store.get(runKey(runId));
      if (!run) throw new NotFoundError();
      return { ...run, cancelRequested: true };
    }
    throw error;
  }
}

export { ENGINE_VERSION };
