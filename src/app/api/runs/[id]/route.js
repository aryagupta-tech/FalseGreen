import { loadConfig } from "../../../../core/config.js";
import { createStore } from "../../../../core/store/index.js";
import { handleApi, json } from "../../../../lib/http.js";
import { getSessionId, requireSameSession } from "../../../../lib/session.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let storeInstance = null;

function getStore(config) {
  if (!storeInstance) storeInstance = createStore(config);
  return storeInstance;
}

export const GET = handleApi(async (_request, { params }) => {
  const { id } = await params;
  const config = loadConfig();
  const store = getStore(config);
  const sessionId = await getSessionId();

  const run = await store.get(`fg:run:${id}`);
  requireSameSession(run, sessionId);

  return json({ run });
});
