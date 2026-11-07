import { describe, expect, it } from "vitest";
import { applyChanges, ListSync, type Page } from "./sync";

interface It { id: string; t: number; v?: string }
const order = (a: It, b: It) => b.t - a.t;
const ids = (l: It[]) => l.map((x) => x.id);

describe("applyChanges", () => {
  const base: It[] = [{ id: "c", t: 3 }, { id: "b", t: 2 }, { id: "a", t: 1 }];

  it("adds, replaces and drops, in order", () => {
    const out = applyChanges(base, [{ id: "d", t: 4 }, { id: "a", t: 1, v: "fav" }], ["b"], order);
    expect(ids(out)).toEqual(["d", "c", "a"]);
    expect(out.find((x) => x.id === "a")!.v).toBe("fav");
  });

  it("never adds an item twice (this device's own upload, already in the list)", () => {
    const out = applyChanges(base, [{ id: "c", t: 3, v: "server" }], [], order);
    expect(ids(out)).toEqual(["c", "b", "a"]);
    expect(out[0].v).toBe("server");
  });

  it("gives back the same list when nothing it holds changed", () => {
    expect(applyChanges(base, [], ["zz"], order)).toBe(base);
    expect(applyChanges(base, [], [], order)).toBe(base);
  });

  it("an id both removed and changed in one page counts as changed (restored after being trashed)", () => {
    expect(ids(applyChanges(base, [{ id: "a", t: 1 }], ["a"], order))).toEqual(["c", "b", "a"]);
  });
});

/** A server stand-in: answers whole lists and ?since from a script, and counts what it was asked. */
function fake(answers: Record<string, Page | Page[]>) {
  const asked: string[] = [];
  const next: Record<string, number> = {};
  const get = async (p: string) => {
    asked.push(p);
    const a = answers[p];
    if (!a) throw new Error("unexpected " + p);
    if (!Array.isArray(a)) return a;
    const i = next[p] ?? 0;
    next[p] = i + 1;
    return a[Math.min(i, a.length - 1)];
  };
  return { asked, get };
}

describe("ListSync", () => {
  const rec = (id: string, t: number, v?: string) => ({ id, t, v });
  let decrypted: string[] = [];
  const decrypt = (raw: any[]) => { decrypted.push(...raw.map((r) => r.id)); return raw.map((r) => ({ ...r })); };

  it("loads the whole list once, then only what changed, decrypting only that", async () => {
    decrypted = [];
    const s = fake({
      "/api/items": { items: [rec("a", 1), rec("b", 2)], next: "x", cursor: "e.5" },
      "/api/items?after=x": { items: [rec("c", 3)], next: "" },
      "/api/items?since=e.5": { items: [rec("d", 4)], removed: ["a"], cursor: "e.7", more: false },
      "/api/items?since=e.7": { items: [], removed: [], cursor: "e.7", more: false },
    });
    const l = new ListSync<It>({ path: "/api/items", get: s.get, decrypt, order });
    expect(ids((await l.load()).items)).toEqual(["c", "b", "a"]);
    decrypted = [];
    const r = await l.load();
    expect(r.full).toBe(false);
    expect(ids(r.items)).toEqual(["d", "c", "b"]);
    expect(decrypted).toEqual(["d"]);
    const again = await l.load();
    expect(again.items).toBe(r.items); // nothing changed: the same list, nothing decrypted
    expect(decrypted).toEqual(["d"]);
    // the whole list was fetched once only
    expect(s.asked.filter((p) => p === "/api/items").length).toBe(1);
  });

  it("follows pages of changes in order", async () => {
    decrypted = [];
    const s = fake({
      "/api/items": { items: [rec("a", 1)], cursor: "e.1" },
      "/api/items?since=e.1": { items: [rec("b", 2)], removed: [], cursor: "e.3", more: true },
      "/api/items?since=e.3": { items: [], removed: ["b"], cursor: "e.4", more: false },
    });
    const l = new ListSync<It>({ path: "/api/items", get: s.get, decrypt, order });
    await l.load();
    expect(ids((await l.load()).items)).toEqual(["a"]); // b came and was purged on the next page
  });

  it("loads the whole list again on reset, and against a server without cursors", async () => {
    const s = fake({
      "/api/items": [{ items: [rec("a", 1)], cursor: "e.1" }, { items: [rec("a", 1), rec("b", 2)], cursor: "f.0" }],
      "/api/items?since=e.1": { items: [], removed: [], cursor: "e.9", reset: true },
    });
    const l = new ListSync<It>({ path: "/api/items", get: s.get, decrypt, order });
    await l.load();
    const r = await l.load();
    expect(r.full).toBe(true);
    expect(ids(r.items)).toEqual(["b", "a"]);

    const old = fake({ "/api/items": [{ items: [rec("a", 1)] }, { items: [rec("b", 2)] }] });
    const o = new ListSync<It>({ path: "/api/items", get: old.get, decrypt, order });
    await o.load();
    expect(ids((await o.load()).items)).toEqual(["b"]);
    expect(old.asked).toEqual(["/api/items", "/api/items"]);
  });

  it("forget: the next load is a whole one", async () => {
    const s = fake({ "/api/items": { items: [rec("a", 1)], cursor: "e.1" } });
    const l = new ListSync<It>({ path: "/api/items", get: s.get, decrypt, order });
    await l.load();
    l.forget();
    expect(l.current).toBeNull();
    await l.load();
    expect(s.asked).toEqual(["/api/items", "/api/items"]);
  });

  it("a load that ran into a forget doesn't bring its list back", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const get = async (p: string): Promise<Page> => { await gate; return { items: [rec("a", 1)], cursor: "e.1" }; };
    const l = new ListSync<It>({ path: "/api/items", get, decrypt, order });
    const p = l.load();
    await new Promise((r) => setTimeout(r, 1)); // waiting for the server now
    l.forget();
    release();
    await p;
    expect(l.current).toBeNull();
  });

  it("runs loads one after another; calls while one waits share it", async () => {
    let inFlight = 0, most = 0, n = 0;
    const get = async (p: string): Promise<Page> => {
      inFlight++; most = Math.max(most, inFlight); n++;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return p.includes("since") ? { items: [], removed: [], cursor: "e.1", more: false } : { items: [rec("a", 1)], cursor: "e.1" };
    };
    const l = new ListSync<It>({ path: "/api/items", get, decrypt, order });
    const first = l.load();
    await new Promise((r) => setTimeout(r, 1)); // running now
    await Promise.all([first, l.load(), l.load(), l.load()]);
    expect(most).toBe(1);
    expect(n).toBe(2); // the first, and one more for all that came while it ran
  });

  it("stops a server whose pages never end", async () => {
    const s = fake({
      "/api/items": { items: [], cursor: "e.1" },
      "/api/items?since=e.1": { items: [], removed: [], cursor: "e.1", more: true },
    });
    const l = new ListSync<It>({ path: "/api/items", get: s.get, decrypt, order });
    await l.load();
    await expect(l.load()).rejects.toThrow();
  });
});
