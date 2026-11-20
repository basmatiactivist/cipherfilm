import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDoc, periodOf, type ReviewDoc } from "@memories/custom";

// The custom reviews document on the phone: saved with the server's version, applied again to another device's save
// on a conflict, an older server explained, watched once per period, and the Play build's gating. The server, the
// encryption and search are stand-ins (the document travels as JSON).
const st = vi.hoisted(() => ({
  server: null as { doc: unknown; version: number } | null,
  sealed: null as unknown,
  puts: 0,
  beforePut: null as (() => void) | null,
  putStatus: 0,
  play: false,
  blocked: {} as Record<string, boolean | undefined>,
  facts: [] as unknown[],
  seen: [] as Record<string, unknown>[],
  found: [] as unknown[],
}));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({ default: {} }));
vi.mock("@crypto/search", () => ({
  decryptReviews: () => JSON.parse(JSON.stringify(st.server!.doc)),
  encryptReviews: (_s: unknown, d: unknown) => { st.sealed = JSON.parse(JSON.stringify(d)); return new Uint8Array(8); },
}));
vi.mock("./api", () => {
  class ApiError extends Error { constructor(public status: number, m = "") { super(m); } }
  return {
    ApiError,
    api: async (method: string, _path: string, body?: { version: number }) => {
      if (method === "GET") {
        if (!st.server) throw new ApiError(404, "not found");
        return { data_enc: "AAAA", version: st.server.version };
      }
      st.puts++;
      if (st.putStatus) throw new ApiError(st.putStatus, "refused");
      st.beforePut?.();
      const at = st.server?.version ?? 0;
      if (body!.version !== at) throw new ApiError(409, "conflict");
      st.server = { doc: st.sealed, version: at + 1 };
      return { version: at + 1 };
    },
  };
});
vi.mock("./session", () => ({ onWipe: () => {}, session: () => ({ me: { user: { id: "alice" } }, masterKey: new Uint8Array(32) }) }));
vi.mock("./search/query", () => ({ search: async () => ({ items: st.found }) }));
vi.mock("./search/engine", () => ({
  indexVersion: () => 0, searchReady: () => true, useSearchProgress: () => ({ phase: "ready" }),
  wordsBlocked: async (q: string) => st.blocked[q],
  explicitAmong: async () => new Set(), searchFiltered: () => true,
}));
vi.mock("./store", () => ({ isPlayBuild: () => st.play }));
vi.mock("./reviewSchedule", () => ({
  cancelReviewNotice: () => {}, loadSchedule: async () => ({ v: 1, entries: [], notified: {} }),
  scheduleFor: (d: unknown, _s: unknown, f: Record<string, unknown>) => { st.seen.push(f); return d; },
  updateSchedule: async (f: (s: unknown) => unknown) => { st.facts.push(1); f({ v: 1, entries: [], notified: {} }); },
}));

const { setLang } = await import("./i18n");
setLang("en");
const R = await import("./reviews");

const review = (id: string, query: string, extra: Partial<ReviewDoc["reviews"][number]> = {}) =>
  ({ id, name: query, query, every: "day" as const, count: 12, notify: false, created: 1, updated: 1, ...extra });
const serverDoc = () => st.server!.doc as ReviewDoc;

describe("the reviews document", () => {
  beforeEach(() => {
    Object.assign(st, { server: null, sealed: null, puts: 0, beforePut: null, putStatus: 0, play: false, blocked: {}, facts: [], seen: [], found: [] });
    R.reviewsChanged(); // read again
  });

  it("photos found while the document is read again still reach the schedule (else it would never notify)", async () => {
    st.server = { doc: { ...emptyDoc(), reviews: [review("a", "beach", { notify: true })] }, version: 1 };
    await R.loadReviews();
    R.reviewsChanged(); // another device (or this one's own save, echoed) changed it: read again when next needed
    st.found = [{ id: "p1", kind: "image", created_at: 1, has_thumb: true, meta: { capture_ts: 1 } }];
    await R.runReview(R.reviewDoc().reviews[0], st.found as never);
    expect(st.seen.some((f) => (f.a as { hasMatches?: boolean } | undefined)?.hasMatches)).toBe(false);
    await R.loadReviews();
    await new Promise((r) => setTimeout(r, 0));
    expect(st.seen.some((f) => (f.a as { hasMatches?: boolean } | undefined)?.hasMatches === true)).toBe(true);
  });

  it("no document yet: starts empty, and the first save makes one", async () => {
    expect((await R.loadReviews()).reviews).toEqual([]);
    const id = await R.saveReview({ name: "", query: "  dogs ", every: "week", count: 12, notify: true });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(serverDoc().reviews.map((r) => [r.name, r.query, r.every, r.notify])).toEqual([["dogs", "dogs", "week", true]]);
    expect(st.server!.version).toBe(1);
  });

  it("another device saved in between: the change is applied to theirs, both kept", async () => {
    st.server = { doc: { ...emptyDoc(), reviews: [review("a", "beach")] }, version: 3 };
    await R.loadReviews();
    st.beforePut = () => {
      st.beforePut = null;
      st.server = { doc: { ...emptyDoc(), reviews: [review("a", "beach"), review("b", "snow")] }, version: 4 };
    };
    await R.saveReview({ name: "Dogs", query: "dog", every: "month", count: 6, notify: false });
    expect(st.puts).toBe(2);
    expect(serverDoc().reviews.map((r) => r.query)).toEqual(["beach", "snow", "dog"]);
    expect(st.server!.version).toBe(5);
    expect(R.reviewDoc().reviews).toHaveLength(3);
  });

  it("gives up after four conflicts", async () => {
    st.server = { doc: emptyDoc(), version: 1 };
    st.beforePut = () => { st.server = { doc: st.server!.doc, version: st.server!.version + 1 }; };
    await expect(R.saveReview({ name: "", query: "dog", every: "day", count: 12, notify: false })).rejects.toThrow("Couldn't save. Try again.");
    expect(st.puts).toBe(4);
  });

  it("an older server refuses the document: the message says it needs an update", async () => {
    st.putStatus = 404;
    await expect(R.saveReview({ name: "", query: "dog", every: "day", count: 12, notify: false })).rejects.toThrow("Your server needs an update for custom reviews.");
    st.putStatus = 400;
    await expect(R.removeReview("x")).rejects.toThrow("Your server needs an update for custom reviews.");
  });

  it("deleting leaves a marker, and a review deleted elsewhere isn't brought back by an edit", async () => {
    st.server = { doc: { ...emptyDoc(), reviews: [review("a", "beach")] }, version: 1 };
    await R.removeReview("a");
    expect(serverDoc().reviews).toEqual([]);
    expect(serverDoc().deleted.a).toBeGreaterThan(0);
    await expect(R.saveReview({ id: "a", name: "", query: "beach", every: "day", count: 12, notify: false })).rejects.toThrow("deleted on another device");
  });

  it("changing how often keeps the history but makes it due again", async () => {
    const now = new Date(2026, 10, 20, 12);
    st.server = { doc: { ...emptyDoc(), reviews: [review("a", "beach")], shown: { a: { period: periodOf("day", now), ids: ["x"], now: ["x"] } } }, version: 1 };
    await R.saveReview({ id: "a", name: "", query: "beach", every: "month", count: 12, notify: false });
    expect(serverDoc().shown.a).toEqual({ period: -1, ids: ["x"], now: [] });
  });

  it("watching records the period once", async () => {
    const now = new Date(2026, 10, 20, 12);
    const r = review("a", "beach");
    st.server = { doc: { ...emptyDoc(), reviews: [r] }, version: 1 };
    await R.loadReviews();
    const items = [{ id: "p1" }, { id: "p2" }] as never[];
    await R.watch(r, items, now);
    expect(serverDoc().shown.a).toEqual({ period: periodOf("day", now), ids: ["p1", "p2"], now: ["p1", "p2"] });
    const puts = st.puts;
    await R.watch(r, items, now);
    expect(st.puts).toBe(puts);
    await R.watch(r, [], new Date(2026, 10, 21, 12)); // nothing shown: nothing recorded
    expect(st.puts).toBe(puts);
  });

  it("Play build: saving needs the words checked on this phone, and passing", async () => {
    st.play = true;
    st.server = { doc: emptyDoc(), version: 1 };
    await expect(R.saveReview({ name: "", query: "dog", every: "day", count: 12, notify: false })).rejects.toThrow("need search set up");
    st.blocked = { dog: false, "bad name": true };
    await expect(R.saveReview({ name: "bad name", query: "dog", every: "day", count: 12, notify: false })).rejects.toThrow("can't be saved");
    expect(st.puts).toBe(0);
    await R.saveReview({ name: "", query: "dog", every: "day", count: 12, notify: false });
    expect(serverDoc().reviews).toHaveLength(1);
  });
});

describe("the Play build's gating", () => {
  const rs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const ok = (m: Record<string, boolean | undefined>) => (r: { id: string }) => m[r.id];

  it("outside the Play build: every review, whatever the check says", () => {
    expect(R.visibleReviews(rs, false, ok({ a: false }))).toEqual({ shown: rs, needsModel: false });
  });

  it("in it: only those that passed; unchecked ones ask for the search model", () => {
    expect(R.visibleReviews(rs, true, ok({ a: true, b: false, c: true }))).toEqual({ shown: [rs[0], rs[2]], needsModel: false });
    expect(R.visibleReviews(rs, true, ok({ a: true }))).toEqual({ shown: [rs[0]], needsModel: true });
    expect(R.visibleReviews(rs, true, ok({}))).toEqual({ shown: [], needsModel: true });
  });

  it("the editor saves only once query and name passed", () => {
    expect(R.editorGate(false, undefined, undefined)).toBe("ok");
    expect(R.editorGate(true, false, false)).toBe("ok");
    expect(R.editorGate(true, true, false)).toBe("blocked");
    expect(R.editorGate(true, false, true)).toBe("blocked");
    expect(R.editorGate(true, true, undefined)).toBe("blocked");
    expect(R.editorGate(true, false, undefined)).toBe("model");
    expect(R.editorGate(true, undefined, undefined)).toBe("model");
  });
});

describe("words", () => {
  it("due now, or when it comes next", () => {
    const now = new Date(2026, 10, 20, 12); // a Friday
    const doc = (period: number) => ({ ...emptyDoc(), shown: { a: { period, ids: [], now: [] } } });
    expect(R.dueLabel(review("a", "x"), emptyDoc(), now)).toBe("Due now");
    expect(R.dueLabel(review("a", "x"), doc(periodOf("day", now)), now)).toBe("Next: tomorrow");
    expect(R.dueLabel(review("a", "x", { every: "week" }), doc(periodOf("week", now)), now)).toBe("Next: Monday");
    expect(R.dueLabel(review("a", "x", { every: "month" }), doc(periodOf("month", now)), now)).toBe("Next: December 1");
    expect(R.periodLabel("month", now)).toBe("November");
    expect(R.periodLabel("week", now)).toBe("This week");
  });
});
