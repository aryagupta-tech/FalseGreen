import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(request) {
  const expected = process.env.FG_ADMIN_KEY || "";
  const provided = request.headers.get("x-admin-key") || "";
  if (expected.length < 16 || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export async function GET(request) {
  if (!authorized(request)) return new Response("Not found", { status: 404 });
  return Response.json({
    hasOidc: Boolean(process.env.VERCEL_OIDC_TOKEN),
    oidcLength: (process.env.VERCEL_OIDC_TOKEN || "").length,
    vercelKeys: Object.keys(process.env).filter((key) => key.startsWith("VERCEL_")).sort(),
    modelConfigured: Boolean(process.env.MODEL_API_BASE_URL && process.env.MODEL_ID),
  });
}
