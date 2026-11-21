import { describe, expect, it } from "vitest";
import { mustLeave, PRIVATE, routeNames } from "./privateRoutes";

describe("private screens at lock and sign-out", () => {
  it("counts the edit screen as private", () => {
    expect(PRIVATE.has("edit")).toBe(true);
    expect(mustLeave("locked", ["edit"])).toBe(true);
    expect(mustLeave("signedOut", routeNames({ routes: [{ name: "edit/[id]" }] }))).toBe(true);
  });

  it("counts the custom reviews (list, editor, story) as private", () => {
    expect(mustLeave("locked", routeNames({ routes: [{ name: "reviews/edit" }] }))).toBe(true);
    expect(mustLeave("signedOut", routeNames({ routes: [{ name: "review/[id]" }] }))).toBe(true);
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

  it("no screen holds the reset up: the editor asks about unsaved changes only while the library is unlocked", async () => {
    // @ts-ignore: runs in Node (vitest), where the app's types have no node:fs
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("./app/", import.meta.url);
    const walk = (u: URL): string[] => (readdirSync(u, { withFileTypes: true }) as { name: string; isDirectory: () => boolean }[])
      .flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, u)) : e.name.endsWith(".tsx") ? [new URL(e.name, u).pathname] : []));
    const guards = walk(dir).flatMap((p) => [...(readFileSync(p, "utf8") as string).matchAll(/usePreventRemove\(([^,]+),/g)].map((m) => `${p.split("/app/")[1]}: ${m[1]}`));
    expect(guards).toEqual(["edit/[id].tsx: changed && !saved && !leaveWith && unlocked"]);
    const edit: string = readFileSync(new URL("./app/edit/[id].tsx", import.meta.url), "utf8");
    expect(edit).toContain('const unlocked = useSession().phase === "unlocked";');
  });
});
