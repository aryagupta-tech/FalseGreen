import { timingSafeEqual } from "node:crypto";
import { Snapshot } from "@vercel/sandbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request) {
  const expected = process.env.FG_ADMIN_KEY || "";
  const provided = request.headers.get("x-admin-key") || "";
  if (expected.length < 16 || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

const KEEP = "snap_Ue7UlZ5RwD9ARJLVjl9IYnksV5cM";

export async function POST(request) {
  if (!authorized(request)) return new Response("Not found", { status: 404 });

  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!projectId) return Response.json({ error: "no_project_id" }, { status: 500 });

  try {
  const list = await Snapshot.list({ projectId, limit: 100 });
  const deleted = [];
  const failed = [];
  let kept = 0;
  let inspected = 0;

  for await (const snapshot of list) {
    inspected += 1;
    if (snapshot.id === KEEP) {
      kept += 1;
      continue;
    }
    try {
      const handle = await Snapshot.get({ snapshotId: snapshot.id });
      await handle.delete();
      deleted.push(snapshot.id);
    } catch (error) {
      failed.push([snapshot.id, error instanceof Error ? error.message : String(error)]);
    }
  }

  return Response.json({ inspected, kept, deleted: deleted.length, failed: failed.length, failures: failed.slice(0, 5) });
  } catch (error) {
    return Response.json(
      { error: "cleanup_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
