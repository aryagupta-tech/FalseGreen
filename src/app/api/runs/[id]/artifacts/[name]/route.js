import { loadConfig } from "../../../../../../core/config.js";
import {
  AppError,
  NotFoundError,
} from "../../../../../../core/errors.js";
import { createStore } from "../../../../../../core/store/index.js";
import { handleApi } from "../../../../../../lib/http.js";
import {
  getSessionId,
  requireSameSession,
} from "../../../../../../lib/session.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let storeInstance = null;

function getStore(config) {
  if (!storeInstance) storeInstance = createStore(config);
  return storeInstance;
}

const TEST_ARTIFACT = {
  key: "falsegreen.generated.test.js",
  fileName: "falsegreen.generated.test.js",
  contentType: "text/javascript; charset=utf-8",
};

const PATCH_ARTIFACT = {
  key: "falsegreen.patch",
  fileName: "falsegreen.patch",
  contentType: "text/x-patch; charset=utf-8",
};

const EVIDENCE_ARTIFACT = {
  key: "falsegreen.evidence.json",
  fileName: "falsegreen.evidence.json",
  contentType: "application/json; charset=utf-8",
};

const ARTIFACTS = Object.freeze({
  test: TEST_ARTIFACT,
  "falsegreen.generated.test.js": TEST_ARTIFACT,
  patch: PATCH_ARTIFACT,
  "falsegreen.patch": PATCH_ARTIFACT,
  evidence: EVIDENCE_ARTIFACT,
  "falsegreen.evidence.json": EVIDENCE_ARTIFACT,
});

export const GET = handleApi(async (_request, { params }) => {
  const { id, name } = await params;
  const config = loadConfig();
  const store = getStore(config);
  const sessionId = await getSessionId();

  const run = await store.get(`fg:run:${id}`);
  requireSameSession(run, sessionId);

  const artifact = ARTIFACTS[String(name)];
  if (!artifact) throw new NotFoundError("Artifact not found.");

  const repair = run.repair;
  if (!repair || repair.status !== "verified") {
    throw new AppError(
      "repair_not_verified",
      "The repair is not verified yet.",
      403,
    );
  }

  const content = repair.artifacts?.[artifact.key];
  if (typeof content !== "string") {
    throw new NotFoundError("Artifact not found.");
  }

  return new Response(content, {
    status: 200,
    headers: {
      "content-type": artifact.contentType,
      "content-disposition": `attachment; filename="${artifact.fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
