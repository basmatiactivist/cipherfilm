import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDoc, periodOf, type ReviewDoc } from "@memories/custom";

// The on-device schedule behind "A review is ready": what the background task may post, and when (it has no key, so
// only ids, rhythms and flags are in it). The file and the notification are stand-ins.
const st = vi.hoisted(() => ({ file: "", posted: [] as string[], allowed: true, active: "background", memories: true }));
vi.mock("expo-file-system", () => ({
  File: class {
    get exists() { return st.file !== ""; }
    async text() { return st.file; }
    textSync() { return st.file; }
    async write(s: string) { st.file = s; }
    delete() { st.file = ""; }
  },
  Paths: { document: "/doc" },
}));
vi.mock("react-native", () => ({ AppState: { get currentState() { return st.active; } } }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: { reviewShow: (title: string) => { if (st.allowed) st.posted.push(title); return st.allowed; }, reviewCancel: () => {} },
}));
vi.mock("./memories", () => ({ memoriesOn: () => st.memories }));
vi.mock("./session", () => ({ onSignOut: () => {}, onWipe: () => {} }));

const { setLang } = await import("./i18n");
setLang("en");
const S = await import("./reviewSchedule");

const at = (d: number, h: number) => new Date(2026, 10, d, h, 30); // November 2026; the 20th is a Friday
const entry = (id: string, extra: Partial<import("./reviewSchedule").Entry> = {}) =>
  ({ id, every: "day" as const, notify: true, period: -1, hasMatches: true, ok: true, ...extra });
const sched = (entries: import("./reviewSchedule").Entry[], notified: Record<string, number> = {}) => ({ v: 1 as const, entries, notified });

describe("what the background notifies", () => {
  it("a due review that notifies, found something and passed the check, in the daytime", () => {
    const s = sched([entry("a"), entry("b", { notify: false }), entry("c", { hasMatches: false }), entry("d", { ok: false })]);
    expect(S.dueToNotify(s, at(20, 12))).toEqual({ ids: ["a"], count: 1 });
  });

  it("nothing before 9:00 or from 21:00", () => {
    const s = sched([entry("a")]);
    expect(S.dueToNotify(s, at(20, 8)).ids).toEqual([]);
    expect(S.dueToNotify(s, at(20, 9)).ids).toEqual(["a"]);
    expect(S.dueToNotify(s, at(20, 20)).ids).toEqual(["a"]);
    expect(S.dueToNotify(s, at(20, 21)).ids).toEqual([]);
  });

  it("not when watched in this period; once per period, again in the next", () => {
    const now = at(20, 12);
    expect(S.dueToNotify(sched([entry("a", { period: periodOf("day", now) })]), now).ids).toEqual([]);
    const s = S.markNotified(sched([entry("a"), entry("w", { every: "week" })]), ["a", "w"], now);
    expect(S.dueToNotify(s, now)).toEqual({ ids: [], count: 2 });
    expect(S.dueToNotify(s, at(21, 10))).toEqual({ ids: ["a"], count: 2 }); // Saturday: a new day, the same week
    expect(S.dueToNotify(s, at(23, 10)).ids).toEqual(["a", "w"]); // Monday: a new week
  });

  it("posts one notification with the number due, and remembers it", async () => {
    st.file = JSON.stringify(sched([entry("a"), entry("b", { every: "month" })]));
    expect(await S.checkReviews(at(20, 12))).toBe(true);
    expect(st.posted).toEqual(["2 reviews are ready"]);
    expect(await S.checkReviews(at(20, 15))).toBe(false);
    expect(st.posted).toHaveLength(1);
    expect(await S.checkReviews(at(21, 9))).toBe(true);
    expect(st.posted.at(-1)).toBe("2 reviews are ready"); // a again; b still due this month (counted, not new)
  });

  describe("posting", () => {
    beforeEach(() => { st.posted = []; st.allowed = true; st.active = "background"; st.memories = true; });

    it("nothing while Memories is off, or the app is on screen", async () => {
      st.file = JSON.stringify(sched([entry("a")]));
      st.memories = false;
      expect(await S.checkReviews(at(20, 12))).toBe(false);
      st.memories = true; st.active = "active";
      expect(await S.checkReviews(at(20, 12))).toBe(false);
      expect(st.posted).toEqual([]);
    });

    it("not allowed by Android: tried again next time", async () => {
      st.file = JSON.stringify(sched([entry("a")]));
      st.allowed = false;
      expect(await S.checkReviews(at(20, 12))).toBe(false);
      st.allowed = true;
      expect(await S.checkReviews(at(20, 13))).toBe(true);
      expect(st.posted).toEqual(["A review is ready"]);
    });
  });
});

describe("the schedule from the document", () => {
  const r = (id: string, extra: Partial<ReviewDoc["reviews"][number]> = {}) =>
    ({ id, name: "secret name", query: "secret words", every: "week" as const, count: 12, notify: true, created: 1, updated: 5, ...extra });

  it("holds no names or searches, only ids, rhythm, flags and the period watched", () => {
    const doc: ReviewDoc = { ...emptyDoc(), reviews: [r("a"), r("b", { every: "day", notify: false })], shown: { a: { period: 2916, ids: ["p"], now: ["p"] } } };
    const s = S.scheduleFor(doc, S.emptySchedule(), { a: { hasMatches: true } });
    expect(s.entries).toEqual([
      { id: "a", every: "week", notify: true, period: 2916, hasMatches: true, ok: true },
      { id: "b", every: "day", notify: false, period: -1, hasMatches: false, ok: true },
    ]);
    expect(JSON.stringify(s)).not.toMatch(/secret|"p"/);
  });

  it("keeps what was learnt; drops gone reviews and their notified periods", () => {
    const prev = S.scheduleFor({ ...emptyDoc(), reviews: [r("a"), r("b")] }, S.emptySchedule(), { a: { hasMatches: true }, b: { hasMatches: true } });
    const s = S.scheduleFor({ ...emptyDoc(), reviews: [r("a")] }, { ...prev, notified: { a: 1, b: 2 } });
    expect(s.entries.map((e) => [e.id, e.hasMatches])).toEqual([["a", true]]);
    expect(s.notified).toEqual({ a: 1 });
  });

  it("Play build: ok only from a check of the review as it is now", () => {
    const doc = { ...emptyDoc(), reviews: [r("a")] };
    expect(S.scheduleFor(doc, S.emptySchedule(), {}, true).entries[0].ok).toBe(false);
    const checked = S.scheduleFor(doc, S.emptySchedule(), { a: { ok: true, checked: 5 } }, true);
    expect(checked.entries[0]).toMatchObject({ ok: true, checked: 5 });
    expect(S.scheduleFor(doc, checked, {}, true).entries[0].ok).toBe(true);
    // edited (here or on another device): not ok until checked again
    expect(S.scheduleFor({ ...emptyDoc(), reviews: [r("a", { updated: 9 })] }, checked, {}, true).entries[0].ok).toBe(false);
    expect(S.scheduleFor(doc, S.emptySchedule(), { a: { ok: false, checked: 5 } }, true).entries[0].ok).toBe(false);
  });

  it("reads back what it wrote, and nothing broken", () => {
    const s = sched([entry("a", { checked: 3 })], { a: 7 });
    expect(S.readSchedule(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(S.readSchedule({ entries: [{ id: 1 }, { id: "x", every: "year", period: 0 }, null], notified: { a: "x" } })).toEqual(S.emptySchedule());
    expect(S.readSchedule("nonsense")).toEqual(S.emptySchedule());
  });

  it("the background task runs for it only while Memories is on and some review notifies", () => {
    st.memories = true;
    st.file = JSON.stringify(sched([entry("a", { notify: false })]));
    expect(S.reviewNoticesWanted()).toBe(false);
    st.file = JSON.stringify(sched([entry("a")]));
    expect(S.reviewNoticesWanted()).toBe(true);
    st.memories = false;
    expect(S.reviewNoticesWanted()).toBe(false);
    st.memories = true;
    S.clearSchedule();
    expect(S.reviewNoticesWanted()).toBe(false);
  });
});
