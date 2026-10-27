import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStore } from "../src/core/store/index.js";
import { createDemoConfig, runPreset } from "../scripts/demo.js";

const INCLUSIVE_GENERATED = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("gives free shipping at exactly 1000", () => {
  expect(shippingFee(1000)).toBe(0);
});
`;

const STRICT_GENERATED = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("charges shipping at exactly 1000 when the rule is exclusive", () => {
  expect(shippingFee(1000)).toBe(99);
});
`;

let config;
let store;
let fileDir;

beforeEach(async () => {
  const demo = await createDemoConfig();
  config = demo.config;
  fileDir = demo.fileDir;
  store = createStore(config);
});

afterEach(async () => {
  await fs.rm(fileDir, { recursive: true, force: true }).catch(() => {});
});

function passBaseline(run) {
  expect(run.baseline).not.toBeNull();
  expect(run.baseline.outcome).toBe("completed");
  expect(run.baseline.counts.total).toBeGreaterThan(0);
  expect(run.baseline.counts.failed).toBe(0);
}

function mutationByFamily(run, family) {
  return run.mutations.find((mutation) => mutation.family === family);
}

async function applyPatchInRepo(patch) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "falsegreen-apply-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "pipe" });
    await fs.writeFile(path.join(repo, "demo.patch"), patch, "utf8");
    execFileSync("git", ["apply", "--check", "demo.patch"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["apply", "demo.patch"], { cwd: repo, stdio: "pipe" });
    return await fs.readFile(path.join(repo, "source.regression.test.js"), "utf8");
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  }
}

describe("offline demo pipeline", () => {
  test("missed-boundary is missed, repaired, verified and shipped as safe artifacts", async () => {
    config.model.apiKey = "sk-demo-secret-value";
    const { run } = await runPreset({ store, config, id: "missed-boundary" });

    passBaseline(run);
    expect(mutationByFamily(run, "boundary").status).toBe("missed");
    expect(mutationByFamily(run, "comparison").status).toBe("caught");
    expect(run.scan).toMatchObject({ tested: 2, caught: 1, missed: 1, errors: 0, timeouts: 0 });

    expect(run.repair.status).toBe("verified");
    expect(run.repair.generatedTest).toBe(INCLUSIVE_GENERATED);
    expect(run.repair.verification.matrix.map((row) => row.id)).toEqual([
      "original-existing",
      "mutant-existing",
      "original-proposed",
      "mutant-proposed",
    ]);
    expect(run.repair.verification.matrix.map((row) => row.observed)).toEqual([
      "pass",
      "pass",
      "pass",
      "fail",
    ]);
    expect(run.repair.verification.matrix.map((row) => row.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);

    const artifacts = run.repair.artifacts;
    expect(Object.keys(artifacts).sort()).toEqual([
      "falsegreen.evidence.json",
      "falsegreen.generated.test.js",
      "falsegreen.patch",
    ]);
    expect(artifacts["falsegreen.generated.test.js"]).toBe(INCLUSIVE_GENERATED);

    const patch = artifacts["falsegreen.patch"];
    expect(patch).toContain("diff --git a/source.regression.test.js b/source.regression.test.js");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/source.regression.test.js");
    expect(await applyPatchInRepo(patch)).toBe(INCLUSIVE_GENERATED);

    const evidence = JSON.parse(artifacts["falsegreen.evidence.json"]);
    expect(evidence.runId).toBe(run.id);
    expect(evidence.model).toEqual({ driver: "demo-scripted", id: "demo-scripted" });
    expect(evidence.repair.mutationId).toBe(run.repair.mutationId);
    expect(evidence.baseline.counts.failed).toBe(0);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("sk-demo-secret-value");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("MODEL_API_KEY");
  });

  test("covered-boundary catches every mutation and requests no repair", async () => {
    const { run } = await runPreset({ store, config, id: "covered-boundary" });

    passBaseline(run);
    expect(run.mutations).toHaveLength(2);
    expect(run.mutations.map((mutation) => mutation.status)).toEqual(["caught", "caught"]);
    expect(run.scan).toMatchObject({ tested: 2, caught: 2, missed: 0, errors: 0, timeouts: 0 });
    expect(run.repair).toBeNull();
    expect(run.selectedMutationId).toBeNull();
  });

  test("requirement-mismatch reports expected 0 and observed 99", async () => {
    const { run } = await runPreset({ store, config, id: "requirement-mismatch" });

    passBaseline(run);
    expect(mutationByFamily(run, "boundary").status).toBe("missed");
    expect(mutationByFamily(run, "comparison").status).toBe("caught");
    expect(run.repair.status).toBe("mismatch");
    expect(run.repair.status).not.toBe("verified");
    expect(run.repair.artifacts).toBeNull();
    expect(run.repair.generatedTest).toBe(INCLUSIVE_GENERATED);

    const mismatch = run.repair.verification.mismatch;
    expect(mismatch.args).toEqual([1000]);
    expect(mismatch.expected).toBe(0);
    expect(mismatch.observed).toBe(99);
    expect(mismatch.requirement).toBe(
      "Orders of ₹1,000 or more receive free shipping. Orders below ₹1,000 pay ₹99 shipping.",
    );
  });

  test("strict-requirement reports expected 99 and observed 0", async () => {
    const { run } = await runPreset({ store, config, id: "strict-requirement" });

    passBaseline(run);
    expect(mutationByFamily(run, "boundary").status).toBe("missed");
    expect(mutationByFamily(run, "comparison").status).toBe("caught");
    expect(run.repair.status).toBe("mismatch");
    expect(run.repair.status).not.toBe("verified");
    expect(run.repair.artifacts).toBeNull();
    expect(run.repair.generatedTest).toBe(STRICT_GENERATED);

    const mismatch = run.repair.verification.mismatch;
    expect(mismatch.args).toEqual([1000]);
    expect(mismatch.expected).toBe(99);
    expect(mismatch.observed).toBe(0);
    expect(mismatch.requirement).toBe(
      "Orders above ₹1,000 receive free shipping. Orders of exactly ₹1,000 pay ₹99 shipping.",
    );
  });
});
