import { ProposalError, validateProposal } from "./proposal.js";

const MAX_TITLE_CHARS = 120;

/**
 * Strip characters that could terminate the string literal or be mistaken for
 * template interpolation. The result is always inserted through
 * JSON.stringify, so this is defence in depth, not the only barrier.
 *
 * @param {unknown} title
 * @returns {string}
 */
export function sanitizeTitle(title) {
  const cleaned = String(title ?? "")
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, " ")
    .replace(/`/g, "")
    .replace(/\$\{[^}]*\}/g, "")
    .replace(/\$\{/g, "")
    .replace(/["']/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const bounded = cleaned.length > MAX_TITLE_CHARS ? cleaned.slice(0, MAX_TITLE_CHARS).trimEnd() : cleaned;
  if (bounded.length >= 3) return bounded;
  if (bounded.length > 0) return `regression: ${bounded}`;
  return "proposed regression test";
}

function isObjectValue(value) {
  return value !== null && typeof value === "object";
}

function renderArgument(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ProposalError("Proposal.args must contain only JSON values.", { field: "args" });
  }
  return serialized;
}

/**
 * Render the validated proposal through the fixed Vitest template. No model
 * text ever lands in an executable position.
 *
 * @param {unknown} _input
 * @param {{ title: string, exportName: string, args: unknown[], expected: unknown, rationale: string }} proposal
 * @returns {{ fileName: string, content: string, testName: string }}
 */
export function renderProposal(_input, proposal) {
  const validated = validateProposal(proposal);

  const testName = sanitizeTitle(validated.title);
  const matcher = isObjectValue(validated.expected) ? "toEqual" : "toBe";
  const expectedSource = JSON.stringify(validated.expected);
  if (expectedSource === undefined) {
    throw new ProposalError("Proposal.expected must be a JSON value.", { field: "expected" });
  }

  const argsSource = validated.args.map(renderArgument).join(", ");
  const titleLiteral = JSON.stringify(testName);

  const content =
    `import { expect, test } from "vitest";\n` +
    `import { ${validated.exportName} } from "./source.js";\n` +
    `\n` +
    `test(${titleLiteral}, () => {\n` +
    `  expect(${validated.exportName}(${argsSource})).${matcher}(${expectedSource});\n` +
    `});\n`;

  return {
    fileName: "source.regression.test.js",
    content,
    testName,
  };
}

export default renderProposal;
