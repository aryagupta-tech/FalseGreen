import { parse } from "@babel/parser";

import { DEFAULT_LIMITS } from "./config.js";
import { ValidationError } from "./errors.js";
import { collectMutations } from "./mutations.js";

const SOURCE_TEST_IMPORT = "./source.js";
const ALLOWED_TEST_IMPORTS = new Set(["vitest", SOURCE_TEST_IMPORT]);

/**
 * @typedef {{ name: string, kind: "function" | "arrow" }} ExportedFunction
 * @typedef {{ field: "requirement" | "source" | "tests", code: string, message: string }} ValidationIssue
 * @typedef {{ ok: true, exports: ExportedFunction[], mutationsAvailable: number }
 *   | { ok: false, errors: ValidationIssue[] }} ValidationResult
 */

/**
 * Parse an ES module with Babel. Parse failures are reported as a
 * ValidationError whose details carry source_parse_error, line and column.
 *
 * @param {string} code
 * @param {{ allowReturnOutsideFunction?: boolean } & Record<string, unknown>} [options]
 * @returns {import("@babel/parser").ParseResult<import("@babel/types").File>}
 */
export function parseModule(code, { allowReturnOutsideFunction = false, ...parserOptions } = {}) {
  try {
    return parse(code, {
      sourceType: "module",
      allowReturnOutsideFunction,
      ...parserOptions,
    });
  } catch (cause) {
    const location = cause && typeof cause === "object" ? cause.loc : null;
    const line = Number.isFinite(location?.line) ? location.line : 1;
    const column = (Number.isFinite(location?.column) ? location.column : 0) + 1;
    const reason =
      (typeof cause?.message === "string"
        ? cause.message
            .replace(/\s*\(\d+:\d+\)\s*$/, "")
            .replace(/\.$/, "")
            .trim()
        : "") || "Invalid syntax";

    throw new ValidationError(
      `Could not parse module at line ${line}, column ${column}: ${reason}.`,
      { code: "source_parse_error", line, column, reason },
    );
  }
}

/** @param {string} value */
function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * @param {Record<string, number> | undefined} limits
 * @param {keyof typeof DEFAULT_LIMITS} key
 */
function limitValue(limits, key) {
  const value = limits?.[key];
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_LIMITS[key];
}

/** @param {number} limit */
function kibibytes(limit) {
  return `${Math.round((limit / 1024) * 10) / 10} KiB`;
}

/**
 * Walk a Babel AST in source order without pulling in @babel/traverse.
 *
 * @param {unknown} node
 * @param {(node: any) => void} visit
 */
function walk(node, visit) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }
  if (typeof node.type === "string") {
    visit(node);
  }
  for (const key of Object.keys(node)) {
    if (
      key === "loc" ||
      key === "start" ||
      key === "end" ||
      key === "range" ||
      key === "extra" ||
      key === "tokens" ||
      key === "comments" ||
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments"
    ) {
      continue;
    }
    const value = node[key];
    if (value && typeof value === "object") {
      walk(value, visit);
    }
  }
}

/**
 * @param {any} node
 * @returns {string | null}
 */
function callModuleSpecifier(node) {
  const argument = node?.arguments?.[0];
  if (argument?.type === "StringLiteral") {
    return argument.value;
  }
  if (argument?.type === "TemplateLiteral" && argument.expressions.length === 0) {
    return argument.quasis[0]?.value?.cooked ?? argument.quasis[0]?.value?.raw ?? null;
  }
  return null;
}

/**
 * @param {any} declaration
 * @returns {{ functionKind: "function" | "arrow", async: boolean, generator: boolean } | null}
 */
function functionInfoOfInit(declaration) {
  if (declaration?.type === "ArrowFunctionExpression") {
    return { functionKind: "arrow", async: Boolean(declaration.async), generator: false };
  }
  if (declaration?.type === "FunctionExpression") {
    return {
      functionKind: "function",
      async: Boolean(declaration.async),
      generator: Boolean(declaration.generator),
    };
  }
  return null;
}

/**
 * @param {any} declaration
 * @param {Map<string, { functionKind: "function" | "arrow" | null, async: boolean, generator: boolean }>} bindings
 */
function addTopLevelBindings(declaration, bindings) {
  if (declaration?.type === "FunctionDeclaration" && declaration.id?.type === "Identifier") {
    bindings.set(declaration.id.name, {
      functionKind: "function",
      async: Boolean(declaration.async),
      generator: Boolean(declaration.generator),
    });
    return;
  }
  if (declaration?.type === "VariableDeclaration") {
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type !== "Identifier") {
        continue;
      }
      const info = functionInfoOfInit(declarator.init);
      bindings.set(declarator.id.name, info ?? { functionKind: null, async: false, generator: false });
    }
    return;
  }
  if (declaration?.type === "ClassDeclaration" && declaration.id?.type === "Identifier") {
    bindings.set(declaration.id.name, { functionKind: null, async: false, generator: false });
  }
}

/**
 * @param {any} program
 */
function topLevelBindings(program) {
  const bindings = new Map();
  for (const node of program.body) {
    addTopLevelBindings(node, bindings);
    if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") &&
      node.declaration
    ) {
      addTopLevelBindings(node.declaration, bindings);
    }
  }
  return bindings;
}

/**
 * @param {any} callee
 */
function calleeName(callee) {
  if (callee?.type === "Identifier") {
    return callee.name;
  }
  if (callee?.type === "MemberExpression") {
    if (!callee.computed && callee.property?.type === "Identifier") {
      return callee.property.name;
    }
    if (callee.computed && callee.property?.type === "StringLiteral") {
      return callee.property.value;
    }
  }
  return null;
}

/**
 * @param {any} member
 */
function isViMockMember(member) {
  if (member?.type !== "MemberExpression") {
    return false;
  }
  const objectName =
    member.object?.type === "Identifier" ? member.object.name : null;
  if (objectName !== "vi") {
    return false;
  }
  const propertyName = calleeName(member);
  return propertyName === "mock" || propertyName === "hoisted";
}

/**
 * @param {ReturnType<typeof parseModule>["program"]} program
 * @param {(issue: ValidationIssue) => void} report
 */
function checkSourceSemantics(program, report) {
  for (const node of program.body) {
    if (node.type === "ImportDeclaration") {
      report({
        field: "source",
        code: "unsupported_import",
        message: `Source must be self-contained. Remove the import of "${node.source.value}".`,
      });
      continue;
    }
    if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.source
    ) {
      report({
        field: "source",
        code: "unsupported_import",
        message: `Source must be self-contained. Remove the re-export of "${node.source.value}".`,
      });
    }
  }

  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      const specifier = callModuleSpecifier(node);
      report({
        field: "source",
        code: "unsupported_import",
        message: specifier
          ? `Source must be self-contained. Remove require("${specifier}").`
          : "Source must be self-contained. Remove require(...).",
      });
      return;
    }
    if (node.type === "ImportExpression") {
      const specifier =
        node.source?.type === "StringLiteral"
          ? node.source.value
          : node.source?.type === "TemplateLiteral" && node.source.expressions.length === 0
            ? node.source.quasis[0]?.value?.cooked ?? node.source.quasis[0]?.value?.raw ?? null
            : null;
      report({
        field: "source",
        code: "unsupported_import",
        message: specifier
          ? `Source must be self-contained. Remove import("${specifier}").`
          : "Source must be self-contained. Remove import(...).",
      });
      return;
    }
    if (node.type === "CallExpression" && node.callee?.type === "Import") {
      const specifier = callModuleSpecifier(node);
      report({
        field: "source",
        code: "unsupported_import",
        message: specifier
          ? `Source must be self-contained. Remove import("${specifier}").`
          : "Source must be self-contained. Remove import(...).",
      });
    }
  });

  const bindings = topLevelBindings(program);
  /** @type {Map<string, ExportedFunction>} */
  const found = new Map();
  let unsupportedExport = false;

  /**
   * @param {string} name
   * @param {"function" | "arrow"} kind
   */
  const addExport = (name, kind) => {
    if (!found.has(name)) {
      found.set(name, { name, kind });
    }
  };

  const rejectExport = (message) => {
    unsupportedExport = true;
    report({ field: "source", code: "unsupported_export", message });
  };

  for (const node of program.body) {
    if (node.type === "ExportDefaultDeclaration") {
      rejectExport("Default exports are not supported. Use a named synchronous function export.");
      continue;
    }
    if (node.type !== "ExportNamedDeclaration" || node.source) {
      continue;
    }

    if (node.declaration) {
      const declaration = node.declaration;
      if (declaration.type === "FunctionDeclaration" && declaration.id?.type === "Identifier") {
        const name = declaration.id.name;
        if (declaration.async) {
          rejectExport(`Exported function "${name}" is async. Export a synchronous function.`);
        } else if (declaration.generator) {
          rejectExport(`Exported function "${name}" is a generator. Export a synchronous function.`);
        } else {
          addExport(name, "function");
        }
      } else if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          if (declarator.id?.type !== "Identifier") {
            continue;
          }
          const info = functionInfoOfInit(declarator.init);
          if (!info) {
            continue;
          }
          const name = declarator.id.name;
          if (info.async) {
            rejectExport(`Exported function "${name}" is async. Export a synchronous function.`);
          } else if (info.generator) {
            rejectExport(`Exported function "${name}" is a generator. Export a synchronous function.`);
          } else {
            addExport(name, info.functionKind);
          }
        }
      }
      continue;
    }

    for (const specifier of node.specifiers ?? []) {
      if (specifier.type !== "ExportSpecifier") {
        continue;
      }
      const exportedName =
        specifier.exported?.type === "Identifier"
          ? specifier.exported.name
          : specifier.exported?.value;
      if (exportedName === "default") {
        rejectExport("Default exports are not supported. Use a named synchronous function export.");
        continue;
      }
      const localName =
        specifier.local?.type === "Identifier" ? specifier.local.name : null;
      if (!localName) {
        continue;
      }
      const info = bindings.get(localName);
      if (!info?.functionKind) {
        continue;
      }
      if (info.async) {
        rejectExport(`Exported function "${exportedName}" is async. Export a synchronous function.`);
      } else if (info.generator) {
        rejectExport(`Exported function "${exportedName}" is a generator. Export a synchronous function.`);
      } else {
        addExport(exportedName, info.functionKind);
      }
    }
  }

  if (found.size === 0 && !unsupportedExport) {
    report({
      field: "source",
      code: "no_exported_function",
      message:
        'Export at least one named synchronous function, for example `export function calculate() {}`.',
    });
  }

  return [...found.values()];
}

/**
 * @param {ReturnType<typeof parseModule>["program"]} program
 * @param {(issue: ValidationIssue) => void} report
 * @returns {{ hasSourceImport: boolean, hasTestCall: boolean }}
 */
function checkTestSemantics(program, report) {
  let hasSourceImport = false;
  let hasTestCall = false;

  for (const node of program.body) {
    if (node.type !== "ImportDeclaration") {
      continue;
    }
    const specifier = node.source?.value;
    if (specifier === SOURCE_TEST_IMPORT) {
      hasSourceImport = true;
    }
    if (!ALLOWED_TEST_IMPORTS.has(specifier)) {
      report({
        field: "tests",
        code: "unsupported_import",
        message: `Only "vitest" and "./source.js" imports are allowed in source.test.js. Found "${specifier}".`,
      });
    }
  }

  walk(program, (node) => {
    if (isViMockMember(node)) {
      report({
        field: "tests",
        code: "unsupported_mock",
        message: "vi.mock and vi.hoisted are not supported. Tests must run against the real module.",
      });
      return;
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      report({
        field: "tests",
        code: "unsupported_syntax",
        message: 'require(...) is not supported in source.test.js. Use "import" instead.',
      });
      return;
    }
    if (node.type === "ImportExpression") {
      report({
        field: "tests",
        code: "unsupported_syntax",
        message: "Dynamic import(...) is not supported in source.test.js.",
      });
      return;
    }
    if (node.type === "CallExpression" && node.callee?.type === "Import") {
      report({
        field: "tests",
        code: "unsupported_syntax",
        message: "Dynamic import(...) is not supported in source.test.js.",
      });
      return;
    }
    if (
      node.type === "MetaProperty" &&
      node.meta?.name === "import" &&
      node.property?.name === "meta"
    ) {
      report({
        field: "tests",
        code: "unsupported_syntax",
        message: "import.meta is not supported in source.test.js.",
      });
      return;
    }
    if (node.type === "CallExpression") {
      if (node.callee?.type === "Identifier" && (node.callee.name === "test" || node.callee.name === "it")) {
        hasTestCall = true;
        return;
      }
      if (
        node.callee?.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        (node.callee.object.name === "test" || node.callee.object.name === "it")
      ) {
        hasTestCall = true;
      }
    }
  });

  return { hasSourceImport, hasTestCall };
}

/**
 * Validate a submitted module and its Vitest suite.
 *
 * @param {{ requirement?: unknown, source?: unknown, tests?: unknown }} input
 * @param {Record<string, number>} [limits]
 * @returns {ValidationResult}
 */
export function validateInput(input, limits = DEFAULT_LIMITS) {
  const { requirement, source, tests } = input ?? {};
  const requirementText = typeof requirement === "string" ? requirement : "";
  const sourceText = typeof source === "string" ? source : "";
  const testsText = typeof tests === "string" ? tests : "";

  /** @type {ValidationIssue[]} */
  const errors = [];
  /** @param {ValidationIssue} issue */
  const report = (issue) => {
    if (
      !errors.some(
        (existing) =>
          existing.field === issue.field &&
          existing.code === issue.code &&
          existing.message === issue.message,
      )
    ) {
      errors.push(issue);
    }
  };

  const maxRequirementBytes = limitValue(limits, "maxRequirementBytes");
  const maxSourceBytes = limitValue(limits, "maxSourceBytes");
  const maxTestsBytes = limitValue(limits, "maxTestsBytes");
  const requirementBytes = utf8Bytes(requirementText);
  const sourceBytes = utf8Bytes(sourceText);
  const testsBytes = utf8Bytes(testsText);
  const sourceTooLarge = sourceBytes > maxSourceBytes;
  const testsTooLarge = testsBytes > maxTestsBytes;

  if (requirementText.trim() === "") {
    report({
      field: "requirement",
      code: "requirement_empty",
      message: "Add a requirement describing the expected behaviour.",
    });
  }
  if (requirementBytes > maxRequirementBytes) {
    report({
      field: "requirement",
      code: "requirement_too_large",
      message: `Requirement is ${requirementBytes} bytes; the limit is ${maxRequirementBytes} bytes (${kibibytes(maxRequirementBytes)}). Shorten it.`,
    });
  }
  if (sourceTooLarge) {
    report({
      field: "source",
      code: "source_too_large",
      message: `Source is ${sourceBytes} bytes; the limit is ${maxSourceBytes} bytes (${kibibytes(maxSourceBytes)}). Remove code you do not need.`,
    });
  }
  if (testsTooLarge) {
    report({
      field: "tests",
      code: "tests_too_large",
      message: `Tests are ${testsBytes} bytes; the limit is ${maxTestsBytes} bytes (${kibibytes(maxTestsBytes)}). Remove tests you do not need.`,
    });
  }

  /** @type {ExportedFunction[]} */
  let exported = [];
  /** @type {ReturnType<typeof parseModule> | null} */
  let parsedSource = null;

  if (!sourceTooLarge) {
    try {
      parsedSource = parseModule(sourceText, { tokens: true });
      exported = checkSourceSemantics(parsedSource.program, report);
    } catch (error) {
      const details = error instanceof ValidationError ? error.details : null;
      const line = details?.line ?? 1;
      const column = details?.column ?? 1;
      const reason = details?.reason ?? "Invalid syntax";
      report({
        field: "source",
        code: "source_parse_error",
        message: `Source could not be parsed at line ${line}, column ${column}: ${reason}.`,
      });
    }
  }

  if (!testsTooLarge) {
    try {
      const testsAst = parseModule(testsText);
      const { hasSourceImport, hasTestCall } = checkTestSemantics(testsAst.program, report);
      if (!hasSourceImport) {
        report({
          field: "tests",
          code: "tests_do_not_import_source",
          message:
            'Import the module under test in source.test.js with `import { name } from "./source.js"`.',
        });
      }
      if (!hasTestCall) {
        report({
          field: "tests",
          code: "no_tests",
          message: "Add at least one test using `test(...)` or `it(...)`.",
        });
      }
    } catch (error) {
      const details = error instanceof ValidationError ? error.details : null;
      const line = details?.line ?? 1;
      const column = details?.column ?? 1;
      const reason = details?.reason ?? "Invalid syntax";
      report({
        field: "tests",
        code: "tests_parse_error",
        message: `Tests could not be parsed at line ${line}, column ${column}: ${reason}.`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    exports: exported,
    mutationsAvailable: collectMutations(sourceText, limits, parsedSource).length,
  };
}
