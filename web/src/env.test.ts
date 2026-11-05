import { expect, test } from "vitest";
import { isSecure } from "./env";

test("isSecure reflects globalThis.isSecureContext", () => {
  (globalThis as any).isSecureContext = true;
  expect(isSecure()).toBe(true);
  (globalThis as any).isSecureContext = false;
  expect(isSecure()).toBe(false);
});
