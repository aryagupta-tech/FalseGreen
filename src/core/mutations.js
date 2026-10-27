import { DEFAULT_LIMITS } from "./config.js";
import { parseModule } from "./validate-input.js";

/**
 * @typedef {"boundary" | "comparison" | "equality" | "logical"} MutationFamily
 * @typedef {{
 *   id: string,
 *   family: MutationFamily,
 *   operator: string,
 *   replacement: string,
 *   start: number,
 *   end: number,
 *   line: number,
 *   column: number,
 *   before: string,
 *   after: string,
 *   change: string,
 * }} Mutation
 */

/** Operator families, in display and tie-break order. */
export const MUTATION_FAMILIES = Object.freeze({
  boundary: Object.freeze({
    label: "Boundary",
    description: "Shift a comparison boundary by one step.",
    pairs: Object.freeze({
      ">=": ">",
      ">": ">=",
      "<=": "<",
      "<": "<=",
    }),
  }),
  comparison: Object.freeze({
    label: "Comparison",
    description: "Reverse the direction of a comparison.",
    pairs: Object.freeze({
      ">=": "<",
      "<": ">=",
      ">": "<=",
      "<=": ">",
    }),
  }),
  equality: Object.freeze({
    label: "Equality",
    description: "Flip strict equality.",
    pairs: Object.freeze({
      "===": "!==",
      "!==": "===",
    }),
  }),
  logical: Object.freeze({
    label: "Logical",
    description: "Swap a logical conjunction for a disjunction.",
    pairs: Object.freeze({
      "&&": "||",
      "||": "&&",
    }),
  }),
});

const FAMILY_ORDER = Object.freeze({
  boundary: 0,
  comparison: 1,
  equality: 2,
  logical: 3,
});

const MUTATED_FAMILIES = Object.freeze({
  ">=": ["boundary", "comparison"],
  ">": ["boundary", "comparison"],
  "<=": ["boundary", "comparison"],
  "<": ["boundary", "comparison"],
  "===": ["equality"],
  "!==": ["equality"],
  "&&": ["logical"],
  "||": ["logical"],
});

/** @param {Record<string, number> | undefined} limits */
function maxMutationCount(limits) {
  const value = limits?.maxMutations;
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_LIMITS.maxMutations;
}

/**
 * Build a 1-based line/column lookup for offsets in a source string.
 *
 * @param {string} source
 */
function lineLocator(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }

  /** @param {number} offset */
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low + 1, column: offset - starts[low] + 1 };
  };
}

/**
 * Locate the exact operator token that sits between the two operands. Babel's
 * token stream keeps comments and parentheses out of the way, so the returned
 * range is always the operator itself.
 *
 * @param {any[]} tokens
 * @param {number} leftEnd
 * @param {number} rightStart
 * @param {string} operator
 */
function findOperatorToken(tokens, leftEnd, rightStart, operator) {
  let found = null;
  for (const token of tokens) {
    if (token.start < leftEnd) {
      continue;
    }
    if (token.start >= rightStart) {
      break;
    }
    if (token.end > rightStart) {
      continue;
    }
    if ((!found || token.start < found.start) && token.value === operator && token.type?.label) {
      found = token;
    }
  }
  return found;
}

/**
 * Collect deterministic mutation candidates ordered by source position.
 *
 * @param {string} source
 * @param {Record<string, number>} [limits]
 * @param {ReturnType<typeof parseModule>} [parsed] already parsed source with tokens
 * @returns {Mutation[]}
 */
export function collectMutations(source, limits = DEFAULT_LIMITS, parsed = null) {
  const ast = parsed ?? parseModule(source, { tokens: true });
  const tokens = ast.tokens ?? [];
  const positionAt = lineLocator(source);

  /** @type {Array<Mutation & { order: number }>} */
  const candidates = [];
  let order = 0;

  const walk = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child);
      }
      return;
    }
    if (
      (node.type === "BinaryExpression" || node.type === "LogicalExpression") &&
      MUTATED_FAMILIES[node.operator]
    ) {
      const token = findOperatorToken(tokens, node.left.end, node.right.start, node.operator);
      if (token) {
        const { line, column } = positionAt(token.start);
        const rightText = source.slice(node.right.start, node.right.end);
        for (const family of MUTATED_FAMILIES[node.operator]) {
          const replacement = MUTATION_FAMILIES[family].pairs[node.operator];
          candidates.push({
            id: "",
            family,
            operator: node.operator,
            replacement,
            start: token.start,
            end: token.end,
            line,
            column,
            before: source,
            after: "",
            change: `${node.operator} ${rightText} becomes ${replacement} ${rightText}`,
            order: order++,
          });
        }
      }
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
        walk(value);
      }
    }
  };

  walk(ast.program);

  candidates.sort(
    (left, right) =>
      left.start - right.start ||
      FAMILY_ORDER[left.family] - FAMILY_ORDER[right.family] ||
      left.order - right.order,
  );

  const limited = candidates.slice(0, maxMutationCount(limits));
  return limited.map((candidate, index) => {
    const { order: _order, ...mutation } = candidate;
    return {
      ...mutation,
      id: `m${index + 1}`,
      after: applyMutation(source, mutation),
    };
  });
}

/**
 * Replace only the operator range described by a mutation.
 *
 * @param {string} source
 * @param {Pick<Mutation, "start" | "end" | "replacement">} mutation
 * @returns {string}
 */
export function applyMutation(source, mutation) {
  return source.slice(0, mutation.start) + mutation.replacement + source.slice(mutation.end);
}
