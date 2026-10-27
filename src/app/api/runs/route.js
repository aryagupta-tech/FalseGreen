import { after } from "next/server";
import { ConflictError, RateLimitError } from "../../../core/errors.js";
import { createRun, enqueueScan } from "../../../core/jobs/engine.js";
import { handleApi, json, readJsonBody } from "../../../lib/http.js";
import { getRuntime } from "../../../lib/runtime.js";
import { scheduleRun } from "../../../lib/schedule.js";
import { getSessionId } from "../../../lib/session.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = handleApi(async (request) => {
  const { config, store } = getRuntime();
  const sessionId = await getSessionId();
  const input = await readJsonBody(request);

  const used = await store.incrementWindow(
    `fg:rate:${sessionId}`,
    60 * 60 * 1000,
  );
  if (used > config.limits.maxRunsPerSessionPerHour) {
    throw new RateLimitError();
  }

  const run = await createRun({
    store,
    limits: config.limits,
    sessionId,
    input: {
      requirement: input.requirement,
      source: input.source,
      tests: input.tests,
    },
  });

  try {
    await enqueueScan({ store, config, run, schedule: false });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new ConflictError("Both scan slots are busy. Try again in a moment.");
    }
    throw error;
  }

  await scheduleRun({ kind: "scan", store, config, runId: run.id, after });
  return json({ runId: run.id, run }, 201);
});
