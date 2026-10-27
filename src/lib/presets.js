/**
 * Demonstration presets. They are ordinary input snapshots: the engine treats
 * them exactly like code typed into the editors.
 */

const SOURCE_INCLUSIVE = `export function shippingFee(orderTotal) {
  return orderTotal >= 1000 ? 0 : 99;
}
`;

const SOURCE_STRICT = `export function shippingFee(orderTotal) {
  return orderTotal > 1000 ? 0 : 99;
}
`;

const TESTS_MISS_BOUNDARY = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("charges shipping below the threshold", () => {
  expect(shippingFee(500)).toBe(99);
});

test("gives free shipping above the threshold", () => {
  expect(shippingFee(1500)).toBe(0);
});
`;

const TESTS_COVER_BOUNDARY = `import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("charges shipping below the threshold", () => {
  expect(shippingFee(500)).toBe(99);
});

test("gives free shipping at exactly the threshold", () => {
  expect(shippingFee(1000)).toBe(0);
});

test("gives free shipping above the threshold", () => {
  expect(shippingFee(1500)).toBe(0);
});
`;

export const INCLUSIVE_REQUIREMENT =
  "Orders of ₹1,000 or more receive free shipping. Orders below ₹1,000 pay ₹99 shipping.";

export const STRICT_REQUIREMENT =
  "Orders above ₹1,000 receive free shipping. Orders of exactly ₹1,000 pay ₹99 shipping.";

export const PRESETS = [
  {
    id: "missed-boundary",
    label: "Missed boundary",
    shortLabel: "Missed boundary",
    description: "Passing tests miss exactly ₹1,000. The model proposes the boundary test.",
    expectation: "a verified repair",
    requirement: INCLUSIVE_REQUIREMENT,
    source: SOURCE_INCLUSIVE,
    tests: TESTS_MISS_BOUNDARY,
  },
  {
    id: "covered-boundary",
    label: "Covered boundary",
    shortLabel: "Covered boundary",
    description: "The existing tests already assert ₹1,000, so the mutation is caught.",
    expectation: "caught mutations",
    requirement: INCLUSIVE_REQUIREMENT,
    source: SOURCE_INCLUSIVE,
    tests: TESTS_COVER_BOUNDARY,
  },
  {
    id: "requirement-mismatch",
    label: "Code contradicts requirement",
    shortLabel: "Requirement mismatch",
    description: "The code uses > while the requirement is inclusive. The boundary test fails on the original.",
    expectation: "a requirement mismatch",
    requirement: INCLUSIVE_REQUIREMENT,
    source: SOURCE_STRICT,
    tests: TESTS_MISS_BOUNDARY,
  },
  {
    id: "strict-requirement",
    label: "Strict requirement",
    shortLabel: "Strict requirement",
    description: "The requirement excludes ₹1,000 but the code includes it. Intent is not inferred from code.",
    expectation: "a requirement mismatch",
    requirement: STRICT_REQUIREMENT,
    source: SOURCE_INCLUSIVE,
    tests: TESTS_MISS_BOUNDARY,
  },
];

export const DEFAULT_PRESET_ID = "missed-boundary";

export function getPreset(id) {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[0];
}

export const PRESET_INPUT = Object.fromEntries(
  PRESETS.map((preset) => [
    preset.id,
    { requirement: preset.requirement, source: preset.source, tests: preset.tests },
  ]),
);
