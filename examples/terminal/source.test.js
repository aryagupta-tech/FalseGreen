import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("charges shipping below the threshold", () => {
  expect(shippingFee(500)).toBe(99);
});

test("gives free shipping above the threshold", () => {
  expect(shippingFee(1500)).toBe(0);
});
