import { unifiedDiffForNewFile } from "../diff.js";

export const ENGINE_VERSION = "0.1.0";

export const ARTIFACT_NAMES = Object.freeze([
  "falsegreen.generated.test.js",
  "falsegreen.patch",
  "falsegreen.evidence.json",
]);

function jsonSafe(value, fallback = null) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return fallback;
    return JSON.parse(encoded);
  } catch {
    return fallback;
  }
}

function mutationSummary(mutation) {
  if (!mutation) return null;
  return {
    id: mutation.id,
    family: mutation.family,
    operator: mutation.operator,
    replacement: mutation.replacement,
    start: mutation.start,
    end: mutation.end,
    line: mutation.line,
    column: mutation.column,
    change: mutation.change,
    status: mutation.status ?? null,
    durationMs: mutation.durationMs ?? null,
    counts: jsonSafe(mutation.counts ?? null),
    reason: mutation.reason ?? null,
  };
}

function baselineSummary(baseline) {
  if (!baseline) return null;
  return {
    outcome: baseline.outcome ?? null,
    counts: jsonSafe(baseline.counts ?? null),
    durationMs: baseline.durationMs ?? null,
    error: baseline.error ?? null,
  };
}

function buildEvidence({ run, repair, mutation, config, modelInfo, generatedAt }) {
  const model = modelInfo || {
    driver: config?.model?.driver ?? null,
    id: config?.model?.id ?? null,
  };

  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    generatedAt,
    runId: run.id,
    timestamps: {
      createdAt: run.createdAt ?? null,
      updatedAt: run.updatedAt ?? null,
      expiresAt: run.expiresAt ?? null,
      deadlineAt: run.deadlineAt ?? null,
      repairStartedAt: repair.startedAt ?? null,
      repairFinishedAt: repair.finishedAt ?? null,
    },
    input: {
      requirement: run.input?.requirement ?? null,
      source: run.input?.source ?? null,
      tests: run.input?.tests ?? null,
      sourceName: run.input?.sourceName ?? "source.js",
      testName: run.input?.testName ?? "source.test.js",
    },
    exports: jsonSafe(run.exports ?? [], []),
    baseline: baselineSummary(run.baseline),
    scan: jsonSafe(run.scan ?? null),
    mutation: mutationSummary(mutation),
    mutations: (run.mutations || []).map(mutationSummary),
    repair: {
      mutationId: repair.mutationId,
      status: repair.status,
      attempts: jsonSafe(repair.attempts ?? [], []),
      proposal: jsonSafe(repair.proposal ?? null),
      generatedTest: repair.generatedTest ?? null,
      verification: jsonSafe(repair.verification ?? null),
      failure: repair.failure ?? null,
      durationMs: repair.durationMs ?? null,
      startedAt: repair.startedAt ?? null,
      finishedAt: repair.finishedAt ?? null,
    },
    model: {
      driver: model.driver ?? null,
      id: model.id ?? null,
    },
    limits: jsonSafe(config?.limits ?? {}, {}),
  };
}

/**
 * Build the three verified-repair artifacts. The patch adds the generated test
 * as a new file and is compatible with `git apply`.
 *
 * @param {{ run: object, repair: object, mutation: object, config: object, modelInfo?: {driver?: string, id?: string}, now?: number }} args
 */
export function buildArtifacts({ run, repair, mutation, config, modelInfo, now = Date.now() }) {
  const generatedTest = repair.generatedTest ?? "";
  const testFileName = "source.regression.test.js";
  const patch = unifiedDiffForNewFile(testFileName, generatedTest);
  const evidence = buildEvidence({ run, repair, mutation, config, modelInfo, generatedAt: now });

  return {
    "falsegreen.generated.test.js": generatedTest,
    "falsegreen.patch": patch,
    "falsegreen.evidence.json": `${JSON.stringify(evidence, null, 2)}\n`,
  };
}
