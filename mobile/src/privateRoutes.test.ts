import { describe, expect, it } from "vitest";
import { mustLeave, PRIVATE, routeNames } from "./privateRoutes";

describe("private screens at lock and sign-out", () => {
  it("counts the edit screen as private", () => {
    expect(PRIVATE.has("edit")).toBe(true);
    expect(mustLeave("locked", ["edit"])).toBe(true);
    expect(mustLeave("signedOut", routeNames({ routes: [{ name: "edit/[id]" }] }))).toBe(true);
  });

  it("resets when a private screen is anywhere in the stack, not only on top", () => {
    const nav = { routes: [{ name: "__root", state: { routes: [{ name: "library" }, { name: "map" }, { name: "unlock" }] } }] };
    expect(routeNames(nav)).toEqual(["__root", "library", "map", "unlock"]);
    expect(mustLeave("locked", ["unlock", ...routeNames(nav)])).toBe(true);
  });

  it("leaves the stack alone while unlocked or starting, and when only public screens are open", () => {
    const nav = { routes: [{ name: "photo/[id]" }, { name: "map" }] };
    expect(mustLeave("unlocked", routeNames(nav))).toBe(false);
    expect(mustLeave("starting", routeNames(nav))).toBe(false);
    expect(mustLeave("locked", routeNames({ routes: [{ name: "index" }, { name: "unlock" }] }))).toBe(false);
    expect(mustLeave("signedOut", [undefined, "signin"])).toBe(false);
  });
});
