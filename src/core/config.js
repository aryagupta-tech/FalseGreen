import os from "node:os";
import path from "node:path";

/** Hard-size and time limits. Every value is configurable through FG_* env vars. */
export const DEFAULT_LIMITS = Object.freeze({
  maxSourceBytes: 65536,
  maxTestsBytes: 65536,
  maxRequirementBytes: 4096,
  maxMutations: 12,
  maxActiveJobs: 2,
  maxModelAttempts: 2,
  testTimeoutMs: 10000,
  scanDeadlineMs: 180000,
  repairDeadlineMs: 120000,
  runTtlMs: 24 * 60 * 60 * 1000,
  maxRunsPerSessionPerHour: 20,
  maxArgsBytes: 4096,
  maxOutputBytes: 65536,
  pollIntervalMs: 700,
});

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadLimits(/** @type {Record<string, string | undefined>} */ env = process.env) {
  return {
    ...DEFAULT_LIMITS,
    maxMutations: positiveInt(env.FG_MAX_MUTATIONS, DEFAULT_LIMITS.maxMutations),
    maxActiveJobs: positiveInt(env.FG_MAX_ACTIVE_JOBS, DEFAULT_LIMITS.maxActiveJobs),
    maxModelAttempts: positiveInt(env.FG_MAX_MODEL_ATTEMPTS, DEFAULT_LIMITS.maxModelAttempts),
    testTimeoutMs: positiveInt(env.FG_TEST_TIMEOUT_MS, DEFAULT_LIMITS.testTimeoutMs),
    scanDeadlineMs: positiveInt(env.FG_SCAN_DEADLINE_MS, DEFAULT_LIMITS.scanDeadlineMs),
    repairDeadlineMs: positiveInt(env.FG_REPAIR_DEADLINE_MS, DEFAULT_LIMITS.repairDeadlineMs),
    runTtlMs: positiveInt(env.FG_RUN_TTL_MS, DEFAULT_LIMITS.runTtlMs),
    maxRunsPerSessionPerHour: positiveInt(
      env.FG_MAX_RUNS_PER_SESSION_PER_HOUR,
      DEFAULT_LIMITS.maxRunsPerSessionPerHour,
    ),
  };
}

/**
 * Runtime configuration. Secrets stay server-side; only `publicConfig` is ever
 * sent to the browser.
 */
export function loadConfig(/** @type {Record<string, string | undefined>} */ env = process.env) {
  const limits = loadLimits(env);
  const onVercel = Boolean(env.VERCEL);

  const executionDriver = env.EXECUTION_DRIVER || (onVercel ? "sandbox" : "local");
  const storeDriver =
    env.STORE_DRIVER || (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? "redis" : "file");

  const modelBaseUrl = env.MODEL_API_BASE_URL?.trim() || "";
  const modelApiKey = env.MODEL_API_KEY?.trim() || "";
  const modelId = env.MODEL_ID?.trim() || "";

  let modelDriver = env.MODEL_DRIVER || "auto";
  if (modelDriver === "auto") {
    modelDriver = modelBaseUrl && modelId ? "openai-compatible" : "unconfigured";
  }

  return {
    limits,
    execution: {
      driver: executionDriver,
      sandboxSnapshotId: env.VERCEL_SANDBOX_SNAPSHOT_ID?.trim() || "",
      sandboxRuntime: env.VERCEL_SANDBOX_RUNTIME?.trim() || "node24",
      vitestVersion: "5.0.5",
      keepLocalArtifacts: env.FG_KEEP_LOCAL_ARTIFACTS === "1",
    },
    store: {
      driver: storeDriver,
      redisUrl: env.UPSTASH_REDIS_REST_URL?.trim() || "",
      redisToken: env.UPSTASH_REDIS_REST_TOKEN?.trim() || "",
      fileDir: env.FG_DATA_DIR?.trim() || path.join(os.tmpdir(), "falsegreen-data"),
    },
    model: {
      driver: modelDriver,
      baseUrl: modelBaseUrl,
      apiKey: modelApiKey,
      id: modelId,
      timeoutMs: positiveInt(env.MODEL_TIMEOUT_MS, 45000),
      temperature: 0,
      maxTokens: positiveInt(env.MODEL_MAX_TOKENS, 900),
    },
    jobDriver: env.JOB_DRIVER || (onVercel ? "vercel-workflow" : "inline"),
    publicConfig: {
      executionDriver,
      modelConfigured: Boolean(modelBaseUrl && modelId),
      modelId: modelId || null,
      limits: {
        maxSourceBytes: limits.maxSourceBytes,
        maxTestsBytes: limits.maxTestsBytes,
        maxRequirementBytes: limits.maxRequirementBytes,
        maxMutations: limits.maxMutations,
        maxModelAttempts: limits.maxModelAttempts,
        testTimeoutMs: limits.testTimeoutMs,
        pollIntervalMs: limits.pollIntervalMs,
      },
    },
  };
}

export function assertProductionConfig(config) {
  if (config.store.driver === "redis" && (!config.store.redisUrl || !config.store.redisToken)) {
    throw new Error("Redis store requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
  }
  if (config.execution.driver === "sandbox" && !config.execution.sandboxSnapshotId) {
    throw new Error(
      "Sandbox execution requires VERCEL_SANDBOX_SNAPSHOT_ID pointing at an image with Node and Vitest installed.",
    );
  }
}
