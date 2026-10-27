import { after } from "next/server";
import {
  ConfigError,
  ConflictError,
  ValidationError,
} from "../../../../../core/errors.js";
import { requestRepair } from "../../../../../core/jobs/engine.js";
import { handleApi, json, readJsonBody } from "../../../../../lib/http.js";
import { getRuntime } from "../../../../../lib/runtime.js";
import { scheduleRun } from "../../../../../lib/schedule.js";
import {
  getSessionId,
  requireSameSession,
} from "../../../../../lib/session.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = handleApi(async (request, { params }) => {
  const { id } = await params;
  const { config, store } = getRuntime();
  const sessionId = await getSessionId();

  const run = await store.get(`fg:run:${id}`);
  requireSameSession(run, sessionId);

  if (!config.publicConfig.modelConfigured) {
    throw new ConfigError(
      "Set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID to propose a repair.",
    );
  }

  const body = await readJsonBody(request);
  const mutationId =
    typeof body.mutationId === "string" ? body.mutationId.trim() : "";
  if (!mutationId) {
    throw new ValidationError("Choose a missed mutation to repair.", {
      field: "mutationId",
    });
  }

  if (
    run.repair &&
    (run.repair.status === "queued" || run.repair.status === "running")
  ) {
    throw new ConflictError("A repair is already running for this run.");
  }

  if (run.status !== "completed") {
    throw new ConflictError(
      "Wait for the scan to finish before proposing a repair.",
    );
  }

  const mutations = Array.isArray(run.mutations) ? run.mutations : [];
  const mutation = mutations.find((item) => item?.id === mutationId);
  if (!mutation) {
    throw new ConflictError("That mutation is not part of this run.");
  }
  if (mutation.status !== "missed") {
    throw new ConflictError("Only a missed mutation can be repaired.");
  }

  const updated = await requestRepair({
    store,
    limits: config.limits,
    config,
    runId: id,
    mutationId,
  });

  await scheduleRun({ kind: "repair", store, config, runId: id, after });
  return json({ run: updated }, 202);
});
