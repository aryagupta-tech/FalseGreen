import { cancelRun } from "../../../../../core/jobs/engine.js";
import { ConflictError } from "../../../../../core/errors.js";
import { handleApi, json } from "../../../../../lib/http.js";
import { getRuntime } from "../../../../../lib/runtime.js";
import { getSessionId, requireSameSession } from "../../../../../lib/session.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = handleApi(async (_request, { params }) => {
  const { id } = await params;
  const { store } = getRuntime();
  const sessionId = await getSessionId();

  const run = await store.get(`fg:run:${id}`);
  requireSameSession(run, sessionId);

  try {
    const updated = await cancelRun({ store, runId: id });
    return json({ run: updated }, 202);
  } catch (error) {
    if (error?.code === "conflict") {
      throw new ConflictError("The run is finishing a step. Try stopping it again.");
    }
    throw error;
  }
});
