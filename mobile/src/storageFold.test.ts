import { describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: async () => ({}) }));
vi.mock("./notices", () => ({ deviceLabel: (s: string) => s }));
const { foldDevices } = await import("./storage");

// A long device list (every browser that ever signed in) is folded to this phone and what needs a look first.
const dev = (id: string, o: Partial<{ last_seen: number; last_upload_at: number; backup_stale: boolean; current: boolean }> = {}) =>
  ({ id, last_seen: 100, last_upload_at: 0, backup_stale: false, ...o });

describe("folding the device list", () => {
  const list = [dev("a"), dev("b", { last_upload_at: 50 }), dev("c"), dev("me", { current: true }), dev("d", { backup_stale: true }), dev("e")];
  it("shows this phone, stale backups and recent uploaders, in their order, and counts the rest", () => {
    const f = foldDevices(list, false);
    expect(f.shown.map((d) => d.id)).toEqual(["b", "me", "d"]);
    expect(f.hidden).toBe(3);
  });
  it("shows everything when opened or short", () => {
    expect(foldDevices(list, true)).toEqual({ shown: list, hidden: 0 });
    expect(foldDevices(list.slice(0, 3), false).hidden).toBe(0);
  });
  it("never hides a stuck backup, even past the limit", () => {
    const many = [dev("me", { current: true }), dev("s1", { backup_stale: true }), dev("s2", { backup_stale: true }), dev("s3", { backup_stale: true }), dev("x")];
    expect(foldDevices(many, false).shown.map((d) => d.id)).toEqual(["me", "s1", "s2", "s3"]);
  });
});
