#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { Sandbox } from "@vercel/sandbox";

const RUNTIME = process.env.FG_SANDBOX_RUNTIME || "node24";
const VITEST_VERSION = process.env.FG_VITEST_VERSION || "5.0.5";
const INSTALL_DIR = "/opt/falsegreen";
const SMOKE_DIR = `${INSTALL_DIR}/smoke`;
const SANDBOX_TIMEOUT_MS = 20 * 60 * 1000;

for (const envFile of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(fileURLToPath(new URL(`../${envFile}`, import.meta.url)));
  } catch {
  }
}

function credentials() {
  const hasOidc = Boolean(process.env.VERCEL_OIDC_TOKEN?.trim());
  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();

  if (hasOidc) return {};
  if (token && teamId && projectId) return { token, teamId, projectId };
  return null;
}

async function main() {
  const auth = credentials();
  if (!auth) {
    console.error("Missing Vercel Sandbox credentials.");
    console.error(
      "Set VERCEL_OIDC_TOKEN (for example with `vercel env pull .env.local`),",
    );
    console.error("or set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID.");
    process.exitCode = 1;
    return;
  }

  console.log(`Creating ${RUNTIME} sandbox for the FalseGreen snapshot.`);
  const sandbox = await Sandbox.create({
    ...auth,
    runtime: RUNTIME,
    networkPolicy: "allow-all",
    ports: [],
    timeout: SANDBOX_TIMEOUT_MS,
  });

  let snapshot = null;
  try {
    await sandbox.runCommand({
      cmd: "mkdir",
      args: ["-p", INSTALL_DIR],
      timeoutMs: 30000,
    });

    await sandbox.writeFiles([
      {
        path: `${INSTALL_DIR}/package.json`,
        content: `${JSON.stringify(
          {
            name: "falsegreen-vitest-runtime",
            private: true,
            type: "module",
            dependencies: { vitest: VITEST_VERSION },
          },
          null,
          2,
        )}\n`,
      },
    ]);

    console.log(`Installing vitest@${VITEST_VERSION} into ${INSTALL_DIR}.`);
    const install = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--no-audit", "--no-fund", "--loglevel=error"],
      cwd: INSTALL_DIR,
      timeoutMs: 8 * 60 * 1000,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    if (install.exitCode !== 0) {
      throw new Error(`npm install failed with exit code ${install.exitCode}.`);
    }

    await verifyVitest(sandbox);

    await sandbox.writeFiles([
      {
        path: `${INSTALL_DIR}/falsegreen-snapshot.json`,
        content: `${JSON.stringify(
          {
            builtAt: new Date().toISOString(),
            runtime: RUNTIME,
            vitestVersion: VITEST_VERSION,
            entry: `${INSTALL_DIR}/node_modules/vitest/vitest.mjs`,
          },
          null,
          2,
        )}\n`,
      },
    ]);

    console.log("Snapshotting.");
    snapshot = await sandbox.snapshot({ expiration: 0 });
  } finally {
    await sandbox.stop().catch(() => {});
  }

  if (!snapshot?.snapshotId) {
    throw new Error("Vercel Sandbox did not return a snapshot id.");
  }

  console.log("");
  console.log(`snapshot id: ${snapshot.snapshotId}`);
  console.log("");
  console.log("Add this to the deployment environment:");
  console.log(`VERCEL_SANDBOX_SNAPSHOT_ID=${snapshot.snapshotId}`);
  console.log(`VERCEL_SANDBOX_RUNTIME=${RUNTIME}`);
}

async function verifyVitest(sandbox) {
  console.log("Verifying that the installed Vitest runs a suite.");
  await sandbox.runCommand({
    cmd: "mkdir",
    args: ["-p", SMOKE_DIR],
    timeoutMs: 30000,
  });

  await sandbox.writeFiles([
    { path: `${SMOKE_DIR}/package.json`, content: '{"type":"module"}\n' },
    {
      path: `${SMOKE_DIR}/vitest.config.mjs`,
      content: `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: ["source.test.js"],
    testTimeout: 10000,
  },
});
`,
    },
    {
      path: `${SMOKE_DIR}/source.js`,
      content: "export function add(a, b) { return a + b; }\n",
    },
    {
      path: `${SMOKE_DIR}/source.test.js`,
      content: `import { expect, test } from "vitest";
import { add } from "./source.js";

test("provisioning smoke test", () => {
  expect(add(2, 3)).toBe(5);
});
`,
    },
  ]);

  const verify = await sandbox.runCommand({
    cmd: "node",
    args: [
      `${INSTALL_DIR}/node_modules/vitest/vitest.mjs`,
      "run",
      "--config",
      "vitest.config.mjs",
      "--reporter=json",
      "--outputFile=results.json",
      "--no-color",
    ],
    cwd: SMOKE_DIR,
    timeoutMs: 120000,
  });

  if (verify.exitCode !== 0) {
    const stderr = await verify.stderr();
    const stdout = await verify.stdout();
    throw new Error(
      `Vitest smoke test failed with exit code ${verify.exitCode}: ${stderr || stdout}`,
    );
  }

  const results = JSON.parse(
    await sandbox.fs.readFile(`${SMOKE_DIR}/results.json`, "utf8"),
  );
  if (results.numPassedTests !== 1 || results.numFailedTests !== 0) {
    throw new Error("Vitest smoke test did not pass exactly one test.");
  }

  await sandbox.runCommand({
    cmd: "rm",
    args: ["-rf", SMOKE_DIR],
    timeoutMs: 30000,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
