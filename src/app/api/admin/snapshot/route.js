import { timingSafeEqual } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const VITEST_VERSION = "5.0.5";
const INSTALL_DIR = "/opt/falsegreen";

function authorized(request) {
  const expected = process.env.FG_ADMIN_KEY || "";
  const provided = request.headers.get("x-admin-key") || "";
  if (expected.length < 16 || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * One-time provisioning endpoint. Set FG_ADMIN_KEY, deploy, POST once to build
 * the pinned Node + Vitest snapshot, then remove the route. It is not part of
 * the product surface.
 */
export async function POST(request) {
  if (!authorized(request)) {
    return new Response("Not found", { status: 404 });
  }

  const sandbox = await Sandbox.create({
    runtime: "node24",
    networkPolicy: "allow-all",
    ports: [],
    timeout: 5 * 60 * 1000,
  });

  try {
    await sandbox.runCommand({ cmd: "mkdir", args: ["-p", INSTALL_DIR], timeoutMs: 10000 });
    await sandbox.writeFiles([
      {
        path: `${INSTALL_DIR}/package.json`,
        content: JSON.stringify(
          {
            name: "falsegreen-snapshot",
            private: true,
            type: "module",
            dependencies: { vitest: VITEST_VERSION },
          },
          null,
          2,
        ),
      },
    ]);

    const install = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--no-audit", "--no-fund", "--loglevel=error"],
      cwd: INSTALL_DIR,
      timeoutMs: 45000,
    });

    if (install.exitCode !== 0) {
      return Response.json(
        {
          error: "install_failed",
          exitCode: install.exitCode,
          stderr: (await install.stderr()).slice(-1200),
        },
        { status: 500 },
      );
    }

    const version = await sandbox.runCommand({
      cmd: "node",
      args: [`${INSTALL_DIR}/node_modules/vitest/vitest.mjs`, "--version"],
      cwd: INSTALL_DIR,
      timeoutMs: 15000,
    });

    if (version.exitCode !== 0) {
      return Response.json(
        { error: "vitest_unavailable", stderr: (await version.stderr()).slice(-800) },
        { status: 500 },
      );
    }

    const snapshot = await sandbox.snapshot({ expiration: 0 });
    return Response.json({
      snapshotId: snapshot.snapshotId,
      vitest: VITEST_VERSION,
      version: (await version.stdout()).trim(),
    });
  } finally {
    await sandbox.stop();
  }
}
