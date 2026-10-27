import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS } from "../src/core/config.js";
import { ValidationError } from "../src/core/errors.js";
import { parseModule, validateInput } from "../src/core/validate-input.js";

const GOOD_SOURCE = `export const shippingFee = (orderTotal) => {
  return orderTotal >= 1000 ? 0 : 5;
};
`;

const GOOD_TESTS = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("gives free shipping at exactly 1000", () => {
  expect(shippingFee(1000)).toBe(0);
});
`;

const input = (overrides = {}) => ({
  requirement: "Orders of 1000 or more ship free.",
  source: GOOD_SOURCE,
  tests: GOOD_TESTS,
  ...overrides,
});

const codes = (result) => result.errors.map((error) => error.code);

describe("validateInput: valid submissions", () => {
  it("accepts an arrow export and counts the demo mutations", () => {
    expect(validateInput(input(), DEFAULT_LIMITS)).toEqual({
      ok: true,
      exports: [{ name: "shippingFee", kind: "arrow" }],
      mutationsAvailable: 2,
    });
  });

  it("accepts function declarations and function expressions", () => {
    const source = `export function add(a, b) {
  return a + b;
}

export const multiply = function (a, b) {
  return a * b;
};
`;
    const result = validateInput(input({ source }));
    expect(result.ok).toBe(true);
    expect(result.exports).toEqual([
      { name: "add", kind: "function" },
      { name: "multiply", kind: "function" },
    ]);
  });

  it("accepts a local declaration re-exported by name", () => {
    const source = `function isFree(total) {
  return total >= 1000;
}

export { isFree };
`;
    const result = validateInput(input({ source }));
    expect(result.ok).toBe(true);
    expect(result.exports).toEqual([{ name: "isFree", kind: "function" }]);
  });

  it("returns mutationsAvailable 0 without rejecting the submission", () => {
    const source = "export function identity(value) {\n  return value;\n}\n";
    expect(validateInput(input({ source }))).toMatchObject({
      ok: true,
      exports: [{ name: "identity", kind: "function" }],
      mutationsAvailable: 0,
    });
  });

  it("expects source.test.js to import ./source.js by default", () => {
    const tests = `import { test } from "vitest";
import { shippingFee } from "./source.js";
test("runs", () => {
  test;
  shippingFee;
});
`;
    expect(validateInput(input({ tests })).ok).toBe(true);
  });
});

describe("validateInput: limits", () => {
  it("rejects an empty or whitespace-only requirement", () => {
    for (const requirement of ["", "   ", "\n\t"]) {
      const result = validateInput(input({ requirement }));
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "requirement", code: "requirement_empty" }),
      );
    }
  });

  it("rejects a requirement over the byte limit", () => {
    const result = validateInput(input({ requirement: "abcd" }), {
      ...DEFAULT_LIMITS,
      maxRequirementBytes: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "requirement",
        code: "requirement_too_large",
        message: expect.stringMatching(/4 bytes.*3 bytes/),
      }),
    );
  });

  it("counts UTF-8 bytes, not string length", () => {
    const result = validateInput(input({ requirement: "éé" }), {
      ...DEFAULT_LIMITS,
      maxRequirementBytes: 3,
    });
    expect(codes(result)).toContain("requirement_too_large");
  });

  it("rejects source over the byte limit", () => {
    const source = `${GOOD_SOURCE}// ${"x".repeat(200)}\n`;
    const result = validateInput(input({ source }), {
      maxSourceBytes: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "source",
        code: "source_too_large",
        message: expect.stringMatching(/bytes.*100 bytes/),
      }),
    );
  });

  it("rejects tests over the byte limit", () => {
    const tests = `${GOOD_TESTS}// ${"x".repeat(200)}\n`;
    const result = validateInput(input({ tests }), {
      ...DEFAULT_LIMITS,
      maxTestsBytes: 20,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "tests",
        code: "tests_too_large",
        message: expect.stringMatching(/20 bytes/),
      }),
    );
  });

  it("falls back to shared defaults for unspecified limits", () => {
    const result = validateInput(input(), { maxSourceBytes: DEFAULT_LIMITS.maxSourceBytes });
    expect(result.ok).toBe(true);
  });
});

describe("validateInput: source parsing", () => {
  it("reports a source parse error with line and column", () => {
    const result = validateInput(input({ source: "export function broken( {\n" }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toEqual({
      field: "source",
      code: "source_parse_error",
      message: expect.stringMatching(/Source could not be parsed at line 2, column \d+:/),
    });
  });

  it("reports the line of an error deeper in the file", () => {
    const result = validateInput(
      input({
        source: `export function ok() {
  return 1;
}
const broken = ;
`,
      }),
    );
    expect(result.errors[0].code).toBe("source_parse_error");
    expect(result.errors[0].message).toMatch(/line 4, column \d+/);
  });
});

describe("validateInput: exported functions", () => {
  it("rejects an async function declaration", () => {
    const result = validateInput(
      input({ source: "export async function load() {\n  return 1;\n}\n" }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        field: "source",
        code: "unsupported_export",
        message: 'Exported function "load" is async. Export a synchronous function.',
      },
    ]);
  });

  it("rejects an async arrow export", () => {
    const result = validateInput(
      input({ source: "export const load = async () => 1;\n" }),
    );
    expect(codes(result)).toContain("unsupported_export");
    expect(result.errors[0].message).toMatch(/load/);
  });

  it("rejects an async function expression export", () => {
    const result = validateInput(
      input({ source: "export const load = async function () {\n  return 1;\n};\n" }),
    );
    expect(codes(result)).toContain("unsupported_export");
  });

  it("rejects a generator function declaration", () => {
    const result = validateInput(
      input({ source: "export function* values() {\n  yield 1;\n}\n" }),
    );
    expect(codes(result)).toContain("unsupported_export");
    expect(result.errors[0].message).toMatch(/generator/);
  });

  it("rejects a generator function expression export", () => {
    const result = validateInput(
      input({ source: "export const values = function* () {\n  yield 1;\n};\n" }),
    );
    expect(codes(result)).toContain("unsupported_export");
  });

  it("rejects a re-exported async function", () => {
    const result = validateInput(
      input({
        source: `async function load() {
  return 1;
}
export { load };
`,
      }),
    );
    expect(codes(result)).toContain("unsupported_export");
  });

  it("rejects default exports", () => {
    for (const source of [
      "export default function shippingFee() {\n  return 0;\n}\n",
      "export default (total) => total >= 1000;\n",
    ]) {
      const result = validateInput(input({ source }));
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("unsupported_export");
      expect(result.errors[0].message).toMatch(/Default exports are not supported/);
    }
  });

  it("rejects a default export even when a named function is present", () => {
    const result = validateInput(
      input({
        source: `export function shippingFee(total) {
  return total >= 1000 ? 0 : 5;
}
export default shippingFee;
`,
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("unsupported_export");
  });

  it("rejects renaming a local export to default", () => {
    const result = validateInput(
      input({
        source: `function shippingFee(total) {
  return total >= 1000 ? 0 : 5;
}
export { shippingFee as default };
`,
      }),
    );
    expect(codes(result)).toContain("unsupported_export");
  });

  it("rejects a module with no exported function", () => {
    for (const source of ["const value = 1;\n", "export const value = 1;\n"]) {
      const result = validateInput(input({ source }));
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("no_exported_function");
    }
  });
});

describe("validateInput: self-contained source", () => {
  it("rejects a static import and names the specifier", () => {
    const result = validateInput(
      input({
        source: `import fs from "node:fs";
export function read() {
  return fs.readFileSync;
}
`,
      }),
    );
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        field: "source",
        code: "unsupported_import",
        message: expect.stringMatching(/node:fs/),
      }),
    );
  });

  it("rejects require with and without a literal specifier", () => {
    const withLiteral = validateInput(
      input({
        source: `export function read() {
  return require("node:fs");
}
`,
      }),
    );
    expect(withLiteral.errors[0].message).toMatch(/require\("node:fs"\)/);

    const withoutLiteral = validateInput(
      input({
        source: `export function read(name) {
  return require(name);
}
`,
      }),
    );
    expect(codes(withoutLiteral)).toContain("unsupported_import");
  });

  it("rejects dynamic import and names the specifier", () => {
    const result = validateInput(
      input({
        source: `export function load() {
  return import("./extra.js");
}
`,
      }),
    );
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        code: "unsupported_import",
        message: expect.stringMatching(/\.\/extra\.js/),
      }),
    );
  });

  it("rejects re-exports from another module", () => {
    const result = validateInput(
      input({
        source: `export { shippingFee } from "./shipping.js";
export function fallback() {
  return 0;
}
`,
      }),
    );
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        code: "unsupported_import",
        message: expect.stringMatching(/\.\/shipping\.js/),
      }),
    );
  });
});

describe("validateInput: test files", () => {
  it("rejects imports other than vitest and ./source.js", () => {
    const tests = `import fs from "node:fs";
import { shippingFee } from "./source.js";
import { test } from "vitest";
test("runs", () => {
  fs;
  shippingFee;
});
`;
    const result = validateInput(input({ tests }));
    expect(result.errors[0]).toEqual({
      field: "tests",
      code: "unsupported_import",
      message:
        'Only "vitest" and "./source.js" imports are allowed in source.test.js. Found "node:fs".',
    });
  });

  it("rejects a test file that never imports ./source.js", () => {
    const tests = `import { test } from "vitest";
test("runs", () => {
  expect(1).toBe(1);
});
`;
    const result = validateInput(input({ tests }));
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "tests",
        code: "tests_do_not_import_source",
      }),
    );
  });

  it("rejects a test file with no test or it call", () => {
    const tests = `import { shippingFee } from "./source.js";

const value = shippingFee(1000);
`;
    const result = validateInput(input({ tests }));
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "tests", code: "no_tests" }),
    );
  });

  it("counts it(...) and test.each(...) as tests", () => {
    const itTests = `import { it } from "vitest";
import { shippingFee } from "./source.js";
it("runs", () => {
  shippingFee(1000);
});
`;
    expect(validateInput(input({ tests: itTests })).ok).toBe(true);

    const eachTests = `import { test } from "vitest";
import { shippingFee } from "./source.js";
test.each([1, 2])("runs %i", () => {
  shippingFee(1000);
});
`;
    expect(validateInput(input({ tests: eachTests })).ok).toBe(true);
  });

  it("rejects vi.mock and vi.hoisted", () => {
    for (const body of [
      'vi.mock("./source.js");',
      'vi.hoisted(() => 1);',
      'vi["mock"]("./source.js");',
    ]) {
      const tests = `import { test, vi } from "vitest";
import { shippingFee } from "./source.js";
${body}
test("runs", () => {
  shippingFee(1000);
});
`;
      const result = validateInput(input({ tests }));
      expect(codes(result)).toContain("unsupported_mock");
    }
  });

  it("rejects require, dynamic import and import.meta in tests", () => {
    for (const body of [
      'const fs = require("node:fs");',
      'const module = import("./source.js");',
      "const url = import.meta.url;",
    ]) {
      const tests = `import { test } from "vitest";
import { shippingFee } from "./source.js";
test("runs", () => {
  ${body}
  shippingFee;
});
`;
      const result = validateInput(input({ tests }));
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "tests", code: "unsupported_syntax" }),
      );
    }
  });

  it("reports a test parse error with line and column", () => {
    const tests = `import { test } from "vitest";
import { shippingFee } from "./source.js";
test("runs", () => {
`;
    const result = validateInput(input({ tests }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        field: "tests",
        code: "tests_parse_error",
        message: expect.stringMatching(/line 4, column \d+/),
      }),
    );
  });
});

describe("parseModule", () => {
  it("returns a Babel File node", () => {
    const ast = parseModule("export const value = 1;\n");
    expect(ast.type).toBe("File");
    expect(ast.program.type).toBe("Program");
    expect(ast.program.body[0].type).toBe("ExportNamedDeclaration");
  });

  it("throws a ValidationError with source_parse_error details", () => {
    let error;
    try {
      parseModule("const broken = ;\n");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toMatch(/line 1, column \d+/);
    expect(error.details).toMatchObject({
      code: "source_parse_error",
      line: 1,
      reason: expect.any(String),
    });
    expect(error.details.column).toBeGreaterThan(0);
  });

  it("honours allowReturnOutsideFunction", () => {
    expect(() => parseModule("return 1;\n")).toThrow(ValidationError);
    expect(parseModule("return 1;\n", { allowReturnOutsideFunction: true }).type).toBe("File");
  });
});
