import { describe, expect, test, vi } from "vitest";
import { parseObservedValue, verifyRepair } from "../src/core/verify.js";
import { renderProposal } from "../src/core/model/render.js";

const REQUEST = "Orders of 1000 or more receive free shipping. Orders below 1000 pay 99.";
const SOURCE = `export function shippingFee(orderTotal) {
  return orderTotal >= 1000 ? 0 : 99;
}
`;
const TESTS = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("charges shipping below the threshold", () => {
  expect(shippingFee(500)).toBe(99);
});
`;
const PROPOSAL = {
  title: "gives free shipping at exactly 1000",
  exportName: "shippingFee",
  args: [1000],
  expected: 0,
  rationale: "The requirement includes exactly 1000.",
};

const OPERATOR_START = SOURCE.indexOf(">=");
const MUTATION = {
  id: "m1",
  family: "boundary",
  operator: ">=",
  replacement: ">",
  start: OPERATOR_START,
  end: OPERATOR_START + 2,
  line: 2,
  column: 10,
  before: SOURCE,
  after: SOURCE.slice(0, OPERATOR_START) + ">" + SOURCE.slice(OPERATOR_START + 2),
  change: ">= 1000 becomes > 1000",
};
const MUTANT_SOURCE = SOURCE.slice(0, OPERATOR_START) + ">" + SOURCE.slice(OPERATOR_START + 2);
const GENERATED = renderProposal({}, PROPOSAL).content;
const TEST_NAME = renderProposal({}, PROPOSAL).testName;
const EXISTING_NAME = "charges shipping below the threshold";

function execution({ outcome = "completed", tests = [], error = null, durationMs = 7 } = {}) {
  const passed = tests.filter((row) => row.status === "passed").length;
  const failed = tests.filter((row) => row.status === "failed").length;
  const skipped = tests.filter((row) => row.status === "skipped").length;
  return {
    outcome,
    counts: { total: tests.length, passed, failed, skipped },
    tests,
    durationMs,
    exitCode: outcome === "completed" ? (failed > 0 ? 1 : 0) : null,
    error,
    logs: { stdout: "", stderr: "" },
  };
}

function pass(name) {
  return { name, status: "passed", failureMessages: [] };
}

function fail(name, message) {
  return { name, status: "failed", failureMessages: [message] };
}

function existingPass() {
  return execution({ tests: [pass(EXISTING_NAME)] });
}

function bothPass() {
  return execution({ tests: [pass(EXISTING_NAME), pass(TEST_NAME)] });
}

function generatedFails(expectedMessage) {
  return execution({ tests: [pass(EXISTING_NAME), fail(TEST_NAME, expectedMessage)] });
}

function queuedRun(results) {
  const calls = [];
  const run = vi.fn(async (options) => {
    calls.push(options);
    const next = results.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("The fake run received more executions than it expected.");
    return next;
  });
  return { run, calls };
}

function verify(run, overrides = {}) {
  return verifyRepair({
    proposal: PROPOSAL,
    generatedTest: GENERATED,
    run,
    source: SOURCE,
    tests: TESTS,
    mutation: MUTATION,
    requirement: REQUEST,
    timeoutMs: 1234,
    ...overrides,
  });
}

const ASSERTION_MESSAGE = "AssertionError: expected 99 to be 0 // Object.is equality";

describe("verifyRepair matrix", () => {
  test("verifies a repair when all four rows meet the contract", async () => {
    const { run, calls } = queuedRun([
      existingPass(),
      existingPass(),
      bothPass(),
      generatedFails(ASSERTION_MESSAGE),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("verified");
    expect(verification.mismatch).toBeNull();
    expect(verification.detail).toBeNull();
    expect(verification.matrix.map((row) => row.id)).toEqual([
      "original-existing",
      "mutant-existing",
      "original-proposed",
      "mutant-proposed",
    ]);
    expect(verification.matrix.map((row) => row.label)).toEqual([
      "Original + existing tests",
      "Mutant + existing tests",
      "Original + proposed test",
      "Mutant + proposed test",
    ]);
    expect(verification.matrix.map((row) => row.expected)).toEqual([
      "pass",
      "pass",
      "pass",
      "fail-proposed",
    ]);
    expect(verification.matrix.map((row) => row.observed)).toEqual([
      "pass",
      "pass",
      "pass",
      "fail",
    ]);
    expect(verification.matrix.map((row) => row.status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(verification.matrix.every((row) => row.durationMs === 7)).toBe(true);
    expect(verification.matrix[3].detail).toContain("expected 99 to be 0");

    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.timeoutMs)).toEqual([1234, 1234, 1234, 1234]);
    expect(calls[0].files).toEqual({ "source.js": SOURCE, "source.test.js": TESTS });
    expect(calls[1].files["source.js"]).toBe(MUTANT_SOURCE);
    expect(calls[1].files["source.js"]).not.toBe(SOURCE);
    expect(calls[2].files["source.regression.test.js"]).toBe(GENERATED);
    expect(calls[3].files["source.regression.test.js"]).toBe(GENERATED);
  });

  test("runs the four rows strictly in order", async () => {
    const order = [];
    const run = vi.fn(async ({ files }) => {
      const proposed = Object.prototype.hasOwnProperty.call(files, "source.regression.test.js");
      const mutant = files["source.js"] === MUTANT_SOURCE;
      order.push(`${mutant ? "mutant" : "original"}-${proposed ? "proposed" : "existing"}`);
      if (proposed && mutant) return generatedFails(ASSERTION_MESSAGE);
      if (proposed) return bothPass();
      return existingPass();
    });

    await verify(run);
    expect(order).toEqual([
      "original-existing",
      "mutant-existing",
      "original-proposed",
      "mutant-proposed",
    ]);
  });

  test("reports a requirement mismatch and parses the observed value", async () => {
    const { run } = queuedRun([
      existingPass(),
      existingPass(),
      generatedFails(ASSERTION_MESSAGE),
      generatedFails(ASSERTION_MESSAGE),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("mismatch");
    expect(verification.mismatch).toEqual({
      requirement: REQUEST,
      args: [1000],
      expected: 0,
      observed: 99,
      message: ASSERTION_MESSAGE,
    });
    expect(verification.detail).toContain("requirement and the implementation disagree");
    expect(verification.matrix[2].observed).toBe("fail");
  });

  test("uses 'different value' when the assertion message cannot be parsed", async () => {
    const { run } = queuedRun([
      existingPass(),
      existingPass(),
      generatedFails("AssertionError: expected { a: 1 } to deeply equal { a: 2 }"),
      generatedFails("AssertionError: expected { a: 1 } to deeply equal { a: 2 }"),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("mismatch");
    expect(verification.mismatch.observed).toBe("different value");
  });

  test("rejects a repair when the mutant still passes the proposed test", async () => {
    const { run } = queuedRun([existingPass(), existingPass(), bothPass(), bothPass()]);
    const verification = await verify(run);

    expect(verification.status).toBe("rejected");
    expect(verification.mismatch).toBeNull();
    expect(verification.matrix[3].observed).toBe("pass");
    expect(verification.detail).toContain("still passes");
  });

  test("does not count a timeout as verified", async () => {
    const { run } = queuedRun([
      existingPass(),
      existingPass(),
      bothPass(),
      execution({ outcome: "timeout", error: "Timed out after 1234 ms." }),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("error");
    expect(verification.matrix[3].observed).toBe("timeout");
    expect(verification.matrix[3].status).toBe("fail");
    expect(verification.detail).toContain("timeout");
  });

  test("does not count a compile/import error as verified", async () => {
    const { run } = queuedRun([
      existingPass(),
      existingPass(),
      bothPass(),
      execution({ outcome: "error", error: "SyntaxError: Unexpected token" }),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("error");
    expect(verification.matrix[3].observed).toBe("error");
    expect(verification.matrix[3].status).toBe("fail");
    expect(verification.detail).toContain("error");
  });

  test("does not count a non-assertion failure of the generated test as verified", async () => {
    const { run } = queuedRun([
      existingPass(),
      existingPass(),
      bothPass(),
      execution({
        tests: [pass(EXISTING_NAME), fail(TEST_NAME, "TypeError: shippingFee is not a function")],
      }),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("error");
    expect(verification.matrix[3].observed).toBe("fail");
    expect(verification.detail).toContain("without an assertion failure");
  });

  test("errors when the generated test did not run against the mutant", async () => {
    const { run } = queuedRun([
      existingPass(),
      existingPass(),
      bothPass(),
      execution({ tests: [pass(EXISTING_NAME)] }),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("error");
    expect(verification.detail).toContain("did not run");
  });

  test("errors when the original implementation fails the existing tests", async () => {
    const { run } = queuedRun([
      execution({ tests: [fail(EXISTING_NAME, "AssertionError: expected 1 to be 2")] }),
      existingPass(),
      bothPass(),
      generatedFails(ASSERTION_MESSAGE),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("error");
    expect(verification.detail).toContain("original implementation");
  });

  test("errors when the mutant is not actually caught by existing tests", async () => {
    const { run } = queuedRun([
      existingPass(),
      execution({ tests: [fail(EXISTING_NAME, "AssertionError: expected 1 to be 2")] }),
      bothPass(),
      generatedFails(ASSERTION_MESSAGE),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("error");
    expect(verification.detail).toContain("cannot be a missed mutation");
  });

  test("errors when the proposed run fails for a reason other than the generated assertion", async () => {
    const { run } = queuedRun([
      existingPass(),
      existingPass(),
      execution({ tests: [fail(EXISTING_NAME, "TypeError: broken")] }),
      generatedFails(ASSERTION_MESSAGE),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("error");
    expect(verification.detail).toContain("without an assertion failure");
  });

  test("turns a thrown execution into an error row and keeps the matrix shape", async () => {
    const { run, calls } = queuedRun([
      existingPass(),
      new Error("sandbox died"),
      bothPass(),
      generatedFails(ASSERTION_MESSAGE),
    ]);
    const verification = await verify(run);

    expect(verification.status).toBe("error");
    expect(verification.matrix).toHaveLength(4);
    expect(verification.matrix[1].observed).toBe("error");
    expect(verification.matrix[1].detail).toContain("sandbox died");
    expect(calls).toHaveLength(4);
  });

  test("returns an error matrix when the mutation cannot be applied", async () => {
    const run = vi.fn();
    const verification = await verify(run, {
      mutation: { id: "bad", replacement: ">" },
    });

    expect(verification.status).toBe("error");
    expect(verification.matrix).toHaveLength(4);
    expect(verification.matrix.every((row) => row.observed === "error")).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  test("supports mutation.after when operator positions are absent", async () => {
    const { run, calls } = queuedRun([
      existingPass(),
      existingPass(),
      bothPass(),
      generatedFails(ASSERTION_MESSAGE),
    ]);
    const verification = await verify(run, {
      mutation: { ...MUTATION, start: undefined, end: undefined, replacement: undefined },
    });

    expect(verification.status).toBe("verified");
    expect(calls[1].files["source.js"]).toBe(MUTATION.after);
  });

  test("uses 'different value' when no assertion message is present", () => {
    expect(parseObservedValue("")).toBe("different value");
    expect(parseObservedValue("AssertionError: expected 99 to be 0")).toBe(99);
    expect(parseObservedValue("AssertionError: expected 'free' to be 'paid'")).toBe("free");
    expect(parseObservedValue("AssertionError: expected null to be 0")).toBeNull();
    expect(parseObservedValue("AssertionError: expected true to be false")).toBe(true);
  });
});
