import { beforeEach, describe, expect, it, vi } from "vitest";

// the setting's file in the app's private files
const t = vi.hoisted(() => ({ file: "" }));
vi.mock("expo-file-system", () => ({
  File: class { get exists() { return t.file !== ""; } textSync() { return t.file; } async write(s: string) { t.file = s; } },
  Paths: { document: "/doc" },
}));

const load = async () => { vi.resetModules(); return import("./memories"); };
import type { Item } from "./library";

const item = (id: string, y: number, m: number, d: number, extra: Partial<Item> = {}): Item => ({
  id, kind: "image", size: 1, segment_count: 1, created_at: 0, has_thumb: true, has_preview: true,
  meta: { name: `${id}.jpg`, mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: new Date(y, m - 1, d, 12).getTime() }, ...extra,
});

describe("memories on the phone", () => {
  beforeEach(() => { t.file = ""; });

  it("uses the shared rules through @memories with the app's items", async () => {
    const { findMemories } = await import("@memories/memories");
    const list = [item("a", 2023, 11, 11), item("b", 2023, 11, 12, { trashed_at: 5 }), item("c", 2024, 11, 9, { broken: true }), item("d", 2021, 11, 13, { kind: "video" })];
    const m = findMemories(list, new Date(2026, 10, 11));
    expect(m.map((x) => [x.yearsAgo, x.items.map((i) => i.id)])).toEqual([[3, ["a"]], [5, ["d"]]]);
    expect(m[0].cover.id).toBe("a");
  });

  it("is on by default and remembers being turned off", async () => {
    let mod = await load();
    expect(mod.memoriesOn()).toBe(true);
    mod.setMemoriesOn(false);
    expect(mod.memoriesOn()).toBe(false);
    await Promise.resolve();
    expect(JSON.parse(t.file)).toEqual({ on: false });
    mod = await load();
    expect(mod.memoriesOn()).toBe(false);
    mod.setMemoriesOn(true);
    mod = await load();
    expect(mod.memoriesOn()).toBe(true);
  });

  it("stays on when the file can't be read", async () => {
    t.file = "{not json";
    expect((await load()).memoriesOn()).toBe(true);
  });

  it("says how long ago in English and German", async () => {
    const { yearsAgo } = await load();
    const i18n = await import("./i18n");
    i18n.setLang("en");
    expect([yearsAgo(1), yearsAgo(3)]).toEqual(["1 year ago", "3 years ago"]);
    i18n.setLang("de");
    expect([yearsAgo(1), yearsAgo(3)]).toEqual(["Vor einem Jahr", "Vor 3 Jahren"]);
    i18n.setLang("en");
  });
});
