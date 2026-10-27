import { describe, expect, test, vi } from "vitest";
import { ConfigError } from "../src/core/errors.js";
import {
  createModel,
  deriveExportNames,
  normalizeBaseUrl,
} from "../src/core/model/index.js";
import { ModelError, ProposalError, validateProposal } from "../src/core/model/proposal.js";
import { renderProposal, sanitizeTitle } from "../src/core/model/render.js";

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
  rationale: "The requirement says orders of 1000 or more ship free.",
};

function modelConfig(fetch, overrides = {}) {
  return {
    limits: { maxArgsBytes: 4096 },
    model: {
      driver: "openai-compatible",
      baseUrl: "https://models.example.com/v1",
      apiKey: "sk-test-secret",
      id: "demo-model",
      timeoutMs: 5000,
      maxTokens: 900,
      fetch,
      ...overrides,
    },
  };
}

function stubModel(content, { status = 200, ok = true, raw = false } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok,
      status,
      json: async () =>
        raw ? content : { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] },
      text: async () => (typeof content === "string" ? content : JSON.stringify(content)),
    };
  });
  return { fetch, calls };
}

function input(overrides = {}) {
  return {
    requirement: "Orders of 1000 or more receive free shipping. Orders below 1000 pay 99.",
    source: SOURCE,
    tests: TESTS,
    mutation: {
      id: "m1",
      family: "boundary",
      operator: ">=",
      replacement: ">",
      line: 2,
      column: 10,
      change: ">= 1000 becomes > 1000",
    },
    execution: {
      outcome: "completed",
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
      tests: [{ name: "charges shipping below the threshold", status: "passed", failureMessages: [] }],
      durationMs: 12,
      error: null,
    },
    ...overrides,
  };
}

describe("createModel driver selection", () => {
  test("unconfigured throws ConfigError with the required message", () => {
    expect(() => createModel({ model: { driver: "unconfigured" } })).toThrow(ConfigError);
    expect(() => createModel({ model: { driver: "unconfigured" } })).toThrow(
      "Set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID",
    );
  });

  test("auto without base URL or model id is unconfigured", () => {
    expect(() => createModel({ model: { driver: "auto", baseUrl: "", id: "" } })).toThrow(ConfigError);
  });

  test("ollama is an alias for openai-compatible with its default base URL", async () => {
    const { fetch, calls } = stubModel(PROPOSAL);
    const model = createModel({ model: { driver: "ollama", id: "llama3", fetch } });

    expect(model.describe()).toEqual({ driver: "openai-compatible", id: "llama3" });
    await model.proposeTest(input());

    expect(calls[0].url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  test("normalizes base URLs with or without /v1", () => {
    expect(normalizeBaseUrl("https://api.example.com")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("https://api.example.com/openai/v1")).toBe(
      "https://api.example.com/openai/v1",
    );
  });

  test("derives exported function names for validation", () => {
    expect(
      deriveExportNames(
        "export function a(){}\nexport const b = () => {};\nexport const c = function () {};\nexport { d as e };\nfunction d(){}",
      ),
    ).toEqual(["a", "b", "c", "e"]);
  });
});

describe("createModel.proposeTest", () => {
  test("posts the strict request and returns a validated proposal", async () => {
    const { fetch, calls } = stubModel(PROPOSAL);
    const model = createModel(modelConfig(fetch));

    const result = await model.proposeTest(input());

    expect(result).toEqual(PROPOSAL);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://models.example.com/v1/chat/completions");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-test-secret");
    expect(calls[0].body.model).toBe("demo-model");
    expect(calls[0].body.temperature).toBe(0);
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(calls[0].body.max_tokens).toBe(900);
    expect(calls[0].body.messages[0].role).toBe("system");
    expect(calls[0].body.messages[1].content).toContain("Orders of 1000 or more");
    expect(calls[0].body.messages[1].content).toContain("shippingFee");
    expect(calls[0].body.messages[1].content).toContain(">= 1000 becomes > 1000");
    expect(calls[0].body.messages[1].content).toContain("charges shipping below the threshold");
    expect(calls[0].body.messages[1].content).not.toContain("sk-test-secret");
    expect(model.describe()).toEqual({ driver: "openai-compatible", id: "demo-model" });
  });

  test("tolerates a fenced JSON block", async () => {
    const content = "Here is the proposal:\n```json\n" + JSON.stringify(PROPOSAL, null, 2) + "\n```";
    const { fetch } = stubModel(content);
    const model = createModel(modelConfig(fetch));

    await expect(model.proposeTest(input())).resolves.toEqual(PROPOSAL);
  });

  test("tolerates prose before and after an un-fenced JSON object", async () => {
    const content = `Result follows: ${JSON.stringify(PROPOSAL)} That is all.`;
    const { fetch } = stubModel(content);
    const model = createModel(modelConfig(fetch));

    await expect(model.proposeTest(input())).resolves.toEqual(PROPOSAL);
  });

  test("rejects extra keys with a retryable ProposalError", async () => {
    const { fetch } = stubModel({ ...PROPOSAL, code: "expect(shippingFee(1000)).toBe(0)" });
    const model = createModel(modelConfig(fetch));

    const error = await model.proposeTest(input()).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProposalError);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("unsupported key");
    expect(error.message).toContain("code");
  });

  test("rejects an export name that is not exported", async () => {
    const { fetch } = stubModel({ ...PROPOSAL, exportName: "notExported" });
    const model = createModel(modelConfig(fetch));

    await expect(model.proposeTest(input())).rejects.toMatchObject({
      name: "ProposalError",
      message: expect.stringContaining("not exported"),
    });
  });

  test("rejects an export name that is not an identifier", async () => {
    const { fetch } = stubModel({ ...PROPOSAL, exportName: "shippingFee); process.exit(1" });
    const model = createModel(modelConfig(fetch));

    await expect(model.proposeTest(input())).rejects.toMatchObject({
      name: "ProposalError",
      message: expect.stringContaining("valid JavaScript identifier"),
    });
  });

  test("rejects oversized args", async () => {
    const { fetch } = stubModel({ ...PROPOSAL, args: ["x".repeat(5000)] });
    const model = createModel(modelConfig(fetch));

    await expect(model.proposeTest(input())).rejects.toMatchObject({
      name: "ProposalError",
      message: expect.stringMatching(/maximum is 4096 bytes/),
    });
  });

  test("rejects more than eight args", async () => {
    const { fetch } = stubModel({ ...PROPOSAL, args: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    const model = createModel(modelConfig(fetch));

    await expect(model.proposeTest(input())).rejects.toMatchObject({
      name: "ProposalError",
      message: expect.stringContaining("at most 8 items"),
    });
  });

  test("rejects a title outside 3..120 characters", async () => {
    const { fetch } = stubModel({ ...PROPOSAL, title: "ab" });
    const model = createModel(modelConfig(fetch));

    await expect(model.proposeTest(input())).rejects.toMatchObject({
      name: "ProposalError",
      message: expect.stringContaining("between 3 and 120"),
    });
  });

  test("rejects a rationale over 500 characters", async () => {
    const { fetch } = stubModel({ ...PROPOSAL, rationale: "r".repeat(501) });
    const model = createModel(modelConfig(fetch));

    await expect(model.proposeTest(input())).rejects.toMatchObject({
      name: "ProposalError",
      message: expect.stringContaining("at most 500 characters"),
    });
  });

  test("rejects a non-JSON expected value passed directly to the validator", () => {
    expect(() => validateProposal({ ...PROPOSAL, expected: () => 0 })).toThrow(ProposalError);
    expect(() => validateProposal({ ...PROPOSAL, expected: undefined })).toThrow(ProposalError);
  });

  test("accepts shared JSON values and rejects circular ones", () => {
    const shared = { fee: 0 };
    expect(() => validateProposal({ ...PROPOSAL, expected: shared, args: [shared, shared] })).not.toThrow();

    const circular = { fee: 0 };
    circular.self = circular;
    expect(() => validateProposal({ ...PROPOSAL, expected: circular })).toThrow(ProposalError);
  });

  test("rejects a code-injection attempt", async () => {
    const injected = {
      ...PROPOSAL,
      title: '"); process.exit(1); //',
      args: [{ toString: "boom" }],
      test: 'import { exec } from "node:child_process"; exec("rm -rf /");',
      mocks: ["vi.mock"],
    };
    const { fetch } = stubModel(injected);
    const model = createModel(modelConfig(fetch));

    const error = await model.proposeTest(input()).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProposalError);
    expect(error.message).toContain("unsupported key");
    expect(error.message).toContain("mocks");
    expect(error.message).toContain("test");
  });

  test("rejects executable strings in args or expected", async () => {
    for (const bad of [
      { ...PROPOSAL, args: ["require('node:fs')"] },
      { ...PROPOSAL, expected: "process.exit(1)" },
      { ...PROPOSAL, expected: { value: "vi.mock('./source.js')" } },
    ]) {
      const { fetch } = stubModel(bad);
      const model = createModel(modelConfig(fetch));
      await expect(model.proposeTest(input())).rejects.toMatchObject({
        name: "ProposalError",
        message: expect.stringContaining("must not contain code or mocks"),
      });
    }
  });

  test("rejects a response that is not a JSON object", async () => {
    const { fetch } = stubModel("I cannot help with that.");
    const model = createModel(modelConfig(fetch));

    await expect(model.proposeTest(input())).rejects.toMatchObject({
      name: "ProposalError",
      message: expect.stringContaining("did not contain a JSON object"),
    });
  });

  test("passes the previous attempt and its validation error back to the model", async () => {
    const { fetch, calls } = stubModel(PROPOSAL);
    const model = createModel(modelConfig(fetch));
    const previousError = "Proposal.args is 5000 bytes; the maximum is 4096 bytes.";

    await model.proposeTest(
      input({
        execution: {
          baseline: {
            outcome: "completed",
            counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
            tests: [],
            durationMs: 10,
            error: null,
          },
          mutant: {
            id: "m1",
            change: ">= 1000 becomes > 1000",
            status: "missed",
            counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
            durationMs: 11,
            reason: null,
          },
        },
        previousAttempt: {
          index: 1,
          error: previousError,
          proposal: { ...PROPOSAL, args: ["x".repeat(5000)] },
          matrix: [{ id: "mutant-proposed", observed: "pass", status: "fail" }],
        },
      }),
    );

    const content = calls[0].body.messages[1].content;
    expect(content).toContain("PREVIOUS ATTEMPT");
    expect(content).toContain(previousError);
    expect(content).toContain("mutant-proposed");
    expect(content).toContain('"status": "missed"');
    expect(content).toContain("Do not repeat the rejected proposal");
  });

  test("wraps a timeout in a retryable ModelError", async () => {
    const fetch = vi.fn(async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });
    const model = createModel(modelConfig(fetch));

    const error = await model.proposeTest(input()).catch((caught) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("5000 ms");
  });

  test("wraps an HTTP failure in a ModelError", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));
    const model = createModel(modelConfig(fetch));

    const error = await model.proposeTest(input()).catch((caught) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect(error.message).toContain("HTTP 429");
    expect(error.retryable).toBe(true);
  });

  test("never places the API key anywhere except the Authorization header", async () => {
    const { fetch, calls } = stubModel(PROPOSAL);
    const model = createModel(modelConfig(fetch));

    await model.proposeTest(input());

    expect(calls[0].url).not.toContain("sk-test-secret");
    expect(JSON.stringify(calls[0].body)).not.toContain("sk-test-secret");
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-test-secret");
  });
});

describe("renderProposal", () => {
  test("renders the exact deterministic Vitest template for a primitive", () => {
    const rendered = renderProposal(input(), PROPOSAL);

    expect(rendered.fileName).toBe("source.regression.test.js");
    expect(rendered.testName).toBe("gives free shipping at exactly 1000");
    expect(rendered.content).toBe(
      `import { expect, test } from "vitest";\n` +
        `import { shippingFee } from "./source.js";\n` +
        `\n` +
        `test("gives free shipping at exactly 1000", () => {\n` +
        `  expect(shippingFee(1000)).toBe(0);\n` +
        `});\n`,
    );
  });

  test("uses toEqual for objects and arrays and JSON-stringifies each argument", () => {
    const objectRendered = renderProposal(
      input(),
      {
        ...PROPOSAL,
        args: [{ total: 1000 }, "vip"],
        expected: { fee: 0 },
      },
    );
    expect(objectRendered.content).toContain(
      `  expect(shippingFee({"total":1000}, "vip")).toEqual({"fee":0});`,
    );
  });

  test("is byte-identical for the same proposal", () => {
    const first = renderProposal(input(), PROPOSAL);
    const second = renderProposal(input(), { ...PROPOSAL, args: [1000] });

    expect(second.content).toBe(first.content);
    expect(second.testName).toBe(first.testName);
  });

  test("sanitizes backticks, interpolation, quotes and newlines in titles", () => {
    const rendered = renderProposal(input(), {
      ...PROPOSAL,
      title: "free `at` ${1000}\nwith \"quotes\" and 'apostrophes'",
    });

    expect(rendered.testName).toBe("free at with quotes and apostrophes");
    expect(rendered.content).not.toContain("`");
    expect(rendered.content).not.toContain("${");
    expect(rendered.content).toContain(
      `test("free at with quotes and apostrophes", () => {`,
    );
  });

  test("neutralizes a code-injection title", () => {
    const rendered = renderProposal(input(), {
      ...PROPOSAL,
      title: '"); process.exit(1); //',
    });

    expect(rendered.testName).not.toContain('"');
    expect(rendered.testName).not.toContain("'");
    expect(rendered.content.trim().split("\n")).toHaveLength(6);
    expect(rendered.content).toContain("process.exit(1)");
    expect(rendered.content).toMatch(/^test\("[^"]*", \(\) => \{$/m);
  });

  test("refuses an export name that is not a safe identifier", () => {
    expect(() =>
      renderProposal(input(), { ...PROPOSAL, exportName: "x); process.exit(1" }),
    ).toThrow(ProposalError);
  });

  test("sanitizeTitle produces a usable fallback for a fully stripped title", () => {
    expect(sanitizeTitle('"""')).toBe("proposed regression test");
  });
});
