import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/core/errors.js";
import {
  applyMutation,
  collectMutations,
  MUTATION_FAMILIES,
} from "../src/core/mutations.js";

const DEMO_SOURCE = `export const shippingFee = (orderTotal) => {
  return orderTotal >= 1000 ? 0 : 5;
};
`;

const ALL_OPERATORS_SOURCE = `const a = x >= 1;
const b = x > 1;
const c = x <= 1;
const d = x < 1;
const e = x === 1;
const f = x !== 1;
const g = x && y;
const h = x || y;
`;

describe("collectMutations: shipping demo", () => {
  it("emits boundary then comparison for orderTotal >= 1000", () => {
    const mutations = collectMutations(DEMO_SOURCE);

    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toMatchObject({
      id: "m1",
      family: "boundary",
      operator: ">=",
      replacement: ">",
      line: 2,
      column: 21,
      before: DEMO_SOURCE,
      change: ">= 1000 becomes > 1000",
    });
    expect(mutations[1]).toMatchObject({
      id: "m2",
      family: "comparison",
      operator: ">=",
      replacement: "<",
      line: 2,
      column: 21,
      before: DEMO_SOURCE,
      change: ">= 1000 becomes < 1000",
    });
    expect(mutations[0].start).toBe(mutations[1].start);
    expect(DEMO_SOURCE.slice(mutations[0].start, mutations[0].end)).toBe(">=");
    expect(mutations[0].after).toBe(
      DEMO_SOURCE.slice(0, mutations[0].start) + ">" + DEMO_SOURCE.slice(mutations[0].end),
    );
    expect(mutations[1].after).toBe(
      DEMO_SOURCE.slice(0, mutations[1].start) + "<" + DEMO_SOURCE.slice(mutations[1].end),
    );
    expect(mutations[0].after).toContain("orderTotal > 1000");
    expect(mutations[1].after).toContain("orderTotal < 1000");
  });
});

describe("collectMutations: families", () => {
  it("covers every boundary and comparison pair", () => {
    const mutations = collectMutations(ALL_OPERATORS_SOURCE, { maxMutations: 100 });
    const slice = (mutation) =>
      ALL_OPERATORS_SOURCE.slice(mutation.start, mutation.end);

    const comparisonMutations = mutations.filter(
      (mutation) => mutation.family === "comparison",
    );
    expect(
      comparisonMutations.map((mutation) => [mutation.operator, mutation.replacement]),
    ).toEqual([
      [">=", "<"],
      [">", "<="],
      ["<=", ">"],
      ["<", ">="],
    ]);

    const boundaryMutations = mutations.filter(
      (mutation) => mutation.family === "boundary",
    );
    expect(
      boundaryMutations.map((mutation) => [mutation.operator, mutation.replacement]),
    ).toEqual([
      [">=", ">"],
      [">", ">="],
      ["<=", "<"],
      ["<", "<="],
    ]);

    for (const mutation of mutations) {
      expect(slice(mutation)).toBe(mutation.operator);
    }
  });

  it("covers equality", () => {
    const mutations = collectMutations(ALL_OPERATORS_SOURCE, {
      maxMutations: 100,
    }).filter((mutation) => mutation.family === "equality");
    expect(mutations.map((mutation) => [mutation.operator, mutation.replacement])).toEqual([
      ["===", "!=="],
      ["!==", "==="],
    ]);
  });

  it("covers logical", () => {
    const mutations = collectMutations(ALL_OPERATORS_SOURCE, {
      maxMutations: 100,
    }).filter((mutation) => mutation.family === "logical");
    expect(mutations.map((mutation) => [mutation.operator, mutation.replacement])).toEqual([
      ["&&", "||"],
      ["||", "&&"],
    ]);
  });

  it("does not mutate unlisted operators", () => {
    const source = `const a = x == 1;
const b = x != 1;
const c = x + 1;
const d = x ?? y;
`;
    expect(collectMutations(source)).toEqual([]);
  });

  it("walks nested binary and logical expressions", () => {
    const source = "const value = (a + b) >= c && d;\n";
    const mutations = collectMutations(source);
    expect(mutations.map((mutation) => mutation.operator)).toEqual([
      ">=",
      ">=",
      "&&",
    ]);
    expect(mutations.map((mutation) => mutation.family)).toEqual([
      "boundary",
      "comparison",
      "logical",
    ]);
  });
});

describe("collectMutations: ordering and capping", () => {
  it("sorts by source start, then family order, then declaration order", () => {
    const mutations = collectMutations(ALL_OPERATORS_SOURCE, {
      maxMutations: 100,
    });

    const starts = mutations.map((mutation) => mutation.start);
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
    expect(mutations.slice(0, 2).map((mutation) => mutation.family)).toEqual([
      "boundary",
      "comparison",
    ]);
    expect(mutations.map((mutation) => mutation.id)).toEqual(
      mutations.map((mutation, index) => `m${index + 1}`),
    );
  });

  it("caps after sorting and still numbers from m1", () => {
    const mutations = collectMutations(ALL_OPERATORS_SOURCE, { maxMutations: 3 });
    expect(mutations).toHaveLength(3);
    expect(
      mutations.map((mutation) => [
        mutation.id,
        mutation.family,
        mutation.operator,
        mutation.replacement,
      ]),
    ).toEqual([
      ["m1", "boundary", ">=", ">"],
      ["m2", "comparison", ">=", "<"],
      ["m3", "boundary", ">", ">="],
    ]);
  });

  it("returns an empty list when maxMutations is zero", () => {
    expect(collectMutations(ALL_OPERATORS_SOURCE, { maxMutations: 0 })).toEqual([]);
  });

  it("returns an empty list for a source without mutations", () => {
    expect(collectMutations("export function identity(value) {\n  return value;\n}\n")).toEqual(
      [],
    );
  });

  it("is deterministic across calls", () => {
    expect(collectMutations(DEMO_SOURCE)).toEqual(collectMutations(DEMO_SOURCE));
  });
});

describe("collectMutations: exact token ranges", () => {
  it("finds the operator through comments and parentheses", () => {
    const source =
      "const r = (orderTotal /* keep >= */) >= /* threshold */ (1000);\n";
    const mutations = collectMutations(source);

    expect(mutations).toHaveLength(2);
    for (const mutation of mutations) {
      expect(source.slice(mutation.start, mutation.end)).toBe(">=");
      expect(mutation.start).toBe(source.lastIndexOf(">="));
    }

    expect(mutations[0].after).toBe(
      "const r = (orderTotal /* keep >= */) > /* threshold */ (1000);\n",
    );
    expect(mutations[1].after).toBe(
      "const r = (orderTotal /* keep >= */) < /* threshold */ (1000);\n",
    );
  });

  it("reports 1-based line and column at the operator", () => {
    const source = "const a = 1;\nconst b = 2;\nconst ok = (a\n  /* note */ >= b);\n";
    const [mutation] = collectMutations(source);
    expect(mutation.line).toBe(4);
    expect(mutation.column).toBe(mutation.start - source.lastIndexOf("\n", mutation.start) );
    expect(source.slice(mutation.start, mutation.end)).toBe(">=");
  });

  it("never replaces operands or comments", () => {
    const source = "const ok = foo(1, 2) /* c */ >= bar(3, 4);\n";
    const [mutation] = collectMutations(source);
    expect(mutation.after).toBe("const ok = foo(1, 2) /* c */ > bar(3, 4);\n");
    expect(mutation.after).toContain("foo(1, 2)");
    expect(mutation.after).toContain("bar(3, 4)");
    expect(mutation.after).toContain("/* c */");
  });
});

describe("applyMutation", () => {
  it("replaces only the recorded range", () => {
    const [mutation] = collectMutations(DEMO_SOURCE);
    expect(applyMutation(DEMO_SOURCE, mutation)).toBe(
      `export const shippingFee = (orderTotal) => {
  return orderTotal > 1000 ? 0 : 5;
};
`,
    );
  });

  it("is deterministic and does not mutate its input", () => {
    const [mutation] = collectMutations(DEMO_SOURCE);
    const first = applyMutation(DEMO_SOURCE, mutation);
    const second = applyMutation(DEMO_SOURCE, mutation);
    expect(first).toBe(second);
    expect(DEMO_SOURCE).toBe(DEMO_SOURCE);
    expect(first).not.toBe(DEMO_SOURCE);
  });

  it("works with a hand-built mutation range", () => {
    expect(
      applyMutation("a >= b", { start: 2, end: 4, replacement: "<" }),
    ).toBe("a < b");
  });
});

describe("MUTATION_FAMILIES", () => {
  it("exposes all families and pairs", () => {
    expect(Object.keys(MUTATION_FAMILIES)).toEqual([
      "boundary",
      "comparison",
      "equality",
      "logical",
    ]);
    expect(MUTATION_FAMILIES.boundary.pairs).toEqual({
      ">=": ">",
      ">": ">=",
      "<=": "<",
      "<": "<=",
    });
    expect(MUTATION_FAMILIES.comparison.pairs).toEqual({
      ">=": "<",
      "<": ">=",
      ">": "<=",
      "<=": ">",
    });
    expect(MUTATION_FAMILIES.equality.pairs).toEqual({
      "===": "!==",
      "!==": "===",
    });
    expect(MUTATION_FAMILIES.logical.pairs).toEqual({
      "&&": "||",
      "||": "&&",
    });
    for (const family of Object.values(MUTATION_FAMILIES)) {
      expect(typeof family.label).toBe("string");
      expect(typeof family.description).toBe("string");
    }
  });
});

describe("collectMutations: parse failures", () => {
  it("throws a ValidationError for unparseable source", () => {
    expect(() => collectMutations("export const = ;\n")).toThrow(ValidationError);
  });
});
