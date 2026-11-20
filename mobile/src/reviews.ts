// Custom reviews (docs/MEMORIES.md "Custom reviews"): a search the person saved ("dogs", "Anna in Zürich"), played as a
// story once a day, week or month with different photos each time. The rules (when one is due, which photos it shows,
// the slides) are the web app's, shared through @memories/custom; the search is this phone's own (search/query.ts),
// filtered exactly as Search is. The reviews live in one document per account, encrypted with the master key: the
// server never learns what a review searches for, what it's called or which photos it showed.
//
// The Play build also hides a review whose search or name is explicit (the filter's word check, which needs the search
// model on this phone): until this phone has checked it, it isn't listed, played or notified. The document keeps it
// as it is, so the person's other devices still have it.
import { useEffect, useState, useSyncExternalStore } from "react";
import { getSodium, b64, unb64 } from "@crypto/sodium";
import { decryptReviews, encryptReviews } from "@crypto/search";
import {
  deleteReview, emptyDoc, isDue, MAX_REVIEWS, nextDue, periodOf, pickReview, readDoc, recordShown, replayed, seedOf, showable, tidy,
  upsertReview, type Every, type Review, type ReviewDoc,
} from "@memories/custom";
import { api, ApiError } from "./api";
import { onWipe, session } from "./session";
import { search } from "./search/query";
import { explicitAmong, indexVersion, searchFiltered, searchReady, useSearchProgress, wordsBlocked } from "./search/engine";
import { isPlayBuild } from "./store";
import { cancelReviewNotice, scheduleFor, updateSchedule, loadSchedule, type Facts } from "./reviewSchedule";
import type { Item } from "./library";
import { locale, t } from "./i18n";

export type { Every, Review, ReviewDoc };

const PATH = "/api/me/blobs/reviews";

let doc: ReviewDoc = emptyDoc();
let version = 0;
let loaded = false;
let loading: Promise<ReviewDoc> | null = null;
let ver = 0;
let wipes = 0; // a load still going when the library locks is dropped
const subs = new Set<() => void>();
const bump = () => { ver++; subs.forEach((f) => f()); };

const need = () => {
  const { me, masterKey } = session();
  if (!me || !masterKey) throw new Error(t("Unlock your library first."));
  return { me, masterKey };
};

/** An older server doesn't know the reviews document: it refuses it (404, or 400 from some versions). */
export const oldServer = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 400);
export const OLD_SERVER = () => t("Your server needs an update for custom reviews.");

/** The document as it is now (what was loaded or saved last). */
export const reviewDoc = () => doc;
export const reviewsLoaded = () => loaded;

export function loadReviews(): Promise<ReviewDoc> {
  loading ??= (async () => {
    const { me, masterKey } = need();
    const s = await getSodium();
    const w = wipes;
    let next = emptyDoc(), at = 0;
    try {
      const r = await api<{ data_enc: string; version: number }>("GET", PATH);
      next = readDoc(decryptReviews(s, unb64(s, r.data_enc), masterKey, me.user.id));
      at = r.version;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
    if (w !== wipes) throw new Error(t("Unlock your library first."));
    doc = next; version = at; loaded = true;
    void syncSchedule();
    return doc;
  })().finally(() => { loading = null; });
  return loading;
}

/**
 * Applies a change and saves it; if another device saved in between (409), the document is read again and the change
 * applied to theirs, up to 4 times. f returns null when there is nothing to change (any more).
 */
async function change(f: (d: ReviewDoc) => ReviewDoc | null): Promise<void> {
  const { me, masterKey } = need();
  const s = await getSodium();
  for (let i = 0; i < 4; i++) {
    if (!loaded || i > 0) { loaded = false; await loadReviews(); }
    const changed = f(JSON.parse(JSON.stringify(doc)) as ReviewDoc);
    if (!changed) return;
    const next = tidy(changed, Date.now());
    try {
      const r = await api<{ version: number }>("PUT", PATH, { data_enc: b64(s, encryptReviews(s, next, masterKey, me.user.id)), version });
      doc = next; version = r.version; bump();
      void syncSchedule();
      return;
    } catch (e) {
      if (oldServer(e)) throw new Error(OLD_SERVER());
      if (!(e instanceof ApiError && e.status === 409)) throw e;
    }
  }
  throw new Error(t("Couldn't save. Try again."));
}

const newId = async () => { const s = await getSodium(); return s.to_hex(s.randombytes_buf(8)); };

export interface ReviewInput { id?: string; name: string; query: string; every: Every; count: number; notify: boolean }

/** Adds a review or changes one; returns its id. In the Play build only once its words passed the check here. */
export async function saveReview(input: ReviewInput): Promise<string> {
  const query = input.query.trim();
  if (!query) throw new Error(t("Type what to search for."));
  if (isPlayBuild()) {
    const gate = editorGate(true, await wordsBlocked(query), await wordsBlocked(input.name.trim() || query));
    if (gate === "model") throw new Error(t("Custom reviews need search set up on this phone."));
    if (gate === "blocked") throw new Error(t("This can't be saved as a review."));
  }
  const id = input.id ?? await newId();
  const now = Date.now();
  await change((d) => {
    if (d.deleted[id] !== undefined) return null; // deleted on another device meanwhile: stays deleted
    const old = d.reviews.find((x) => x.id === id);
    if (!old && d.reviews.length >= MAX_REVIEWS) throw new Error(t("You can have at most {n} custom reviews.", { n: MAX_REVIEWS }));
    const next = upsertReview(d, {
      ...old, id, name: input.name, query, every: input.every, count: input.count, notify: input.notify, created: old?.created ?? now, updated: now,
    }, now);
    // another rhythm counts its periods differently: due again at once, its history kept
    if (old && old.every !== input.every && next.shown[id]) next.shown[id] = { ...next.shown[id], period: -1, now: [] };
    return next;
  });
  const saved = doc.reviews.find((x) => x.id === id);
  if (!saved) throw new Error(t("This review was deleted on another device."));
  if (isPlayBuild()) { checks.set(id, { updated: saved.updated, ok: true }); void syncSchedule({ [id]: { ok: true, checked: saved.updated } }); }
  return id;
}

export async function removeReview(id: string) {
  await change((d) => (d.reviews.some((r) => r.id === id) || d.deleted[id] === undefined ? deleteReview(d, id, Date.now()) : null));
}

/** Another device changed the document (live.ts): it is read again when next needed. */
export function reviewsChanged() {
  if (!loaded) return;
  loaded = false;
  bump();
}

// ---- running a review ----

/** Search's close matches for a review's words, among what a review may show (no trash, locked folder, damaged). */
const runs = new Map<string, { key: string; matches: Item[] }>();
const listIds = new WeakMap<object, number>();
let lists = 0;
const listId = (l: object) => { let n = listIds.get(l); if (n === undefined) listIds.set(l, (n = ++lists)); return n; };

export async function matchesFor(query: string, items: Item[]): Promise<Item[]> {
  const key = `${listId(items)}:${indexVersion()}:${searchReady()}:${searchFiltered()}`;
  const hit = runs.get(query);
  if (hit?.key === key) return hit.matches;
  const r = await search(query, items.filter((i) => !i.broken));
  const found = r.items.filter(showable);
  const explicit = await explicitAmong(found.map((m) => m.id));
  const matches = explicit.size ? found.filter((m) => !explicit.has(m.id)) : found;
  runs.set(query, { key, matches });
  if (runs.size > 40) runs.delete(runs.keys().next().value!);
  return matches;
}

export interface Run { matches: Item[]; picked: Item[]; period: number }

/** What a review shows now: this period's story again if it was watched already (on any device), else a new pick. */
export async function runReview(r: Review, items: Item[], now = new Date()): Promise<Run> {
  const matches = await matchesFor(r.query, items);
  const period = periodOf(r.every, now);
  const picked = replayed(doc, r.id, period, matches) ?? pickReview(matches, r.count, doc.shown[r.id]?.ids ?? [], seedOf(r.id, period));
  noteMatches(r.id, matches.length > 0);
  return { matches, picked, period };
}

/** Watched: remembered for this period (once), so it isn't due again until the next and the next shows other photos. */
export async function watch(r: Review, picked: Item[], now = new Date()) {
  const period = periodOf(r.every, now);
  cancelReviewNotice();
  if (!picked.length || doc.shown[r.id]?.period === period) return;
  const ids = picked.map((p) => p.id);
  await change((d) => (d.shown[r.id]?.period === period || !d.reviews.some((x) => x.id === r.id) ? null : recordShown(d, r.id, period, ids)));
}

// ---- the Play build's check, and the schedule for notifications ----

/** The Play check per review, for the review as it was (`updated`): true passed, false blocked, undefined not known. */
const checks = new Map<string, { updated: number; ok: boolean | undefined }>();
const found = new Map<string, boolean>();

/** Which reviews this phone lists, plays and notifies: all, outside the Play build; in it only those whose words
 *  passed the check here (ok true). needsModel: some couldn't be checked (no search model on this phone). */
export function visibleReviews<R>(reviews: R[], play: boolean, ok: (r: R) => boolean | undefined): { shown: R[]; needsModel: boolean } {
  if (!play) return { shown: reviews, needsModel: false };
  return { shown: reviews.filter((r) => ok(r) === true), needsModel: reviews.some((r) => ok(r) === undefined) };
}

/** Whether the editor may save: "model" the words can't be checked here, "blocked" they're explicit (Play build only). */
export function editorGate(play: boolean, queryBlocked: boolean | undefined, nameBlocked: boolean | undefined): "ok" | "model" | "blocked" {
  if (!play) return "ok";
  if (queryBlocked === true || nameBlocked === true) return "blocked";
  if (queryBlocked === undefined || nameBlocked === undefined) return "model";
  return "ok";
}

/** The check for one review (Play build): from this run, else from the schedule file when made for this version. */
async function checkReview(r: Review): Promise<boolean | undefined> {
  const c = checks.get(r.id);
  if (c && c.updated === r.updated && c.ok !== undefined) return c.ok;
  const q = await wordsBlocked(r.query);
  const n = q === undefined ? undefined : await wordsBlocked(r.name);
  if (q !== undefined && n !== undefined) {
    const ok = !q && !n;
    checks.set(r.id, { updated: r.updated, ok });
    void syncSchedule({ [r.id]: { ok, checked: r.updated } });
    return ok;
  }
  const e = (await loadSchedule()).entries.find((x) => x.id === r.id);
  return e?.ok && e.checked === r.updated ? true : undefined;
}

async function gated(reviews: Review[]): Promise<{ shown: Review[]; needsModel: boolean }> {
  const play = isPlayBuild();
  if (!play) return visibleReviews(reviews, false, () => true);
  const ok = new Map<string, boolean | undefined>();
  for (const r of reviews) ok.set(r.id, await checkReview(r));
  return visibleReviews(reviews, true, (r) => ok.get(r.id));
}

function noteMatches(id: string, has: boolean) {
  if (found.get(id) === has) return;
  found.set(id, has);
  void syncSchedule({ [id]: { hasMatches: has } });
}

/** Writes the on-device schedule (reviewSchedule.ts) for the document as it is, and lets the background task run for
 *  it when a review notifies. */
async function syncSchedule(facts: Record<string, Facts> = {}) {
  if (!loaded) return;
  const d = doc;
  await updateSchedule((s) => scheduleFor(d, s, facts, isPlayBuild()));
  try { const { scheduleBackground } = require("./backup") as typeof import("./backup"); await scheduleBackground(); } catch { /* next time */ }
}

// ---- for screens ----

export interface ReviewsState { doc: ReviewDoc; shown: Review[] | null; needsModel: boolean; error?: string }

/** The reviews this phone shows, loaded when needed and again when they change (here or on another device). */
export function useReviews(): ReviewsState {
  const v = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => ver);
  const phase = useSearchProgress().phase;
  const [st, setSt] = useState<{ shown: Review[] | null; needsModel: boolean; error?: string }>({ shown: null, needsModel: false });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (!loaded) await loadReviews();
        const g = await gated(doc.reviews);
        if (live) setSt({ ...g, error: undefined });
      } catch (e) {
        if (live) setSt((s) => ({ ...s, shown: s.shown ?? [], error: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => { live = false; };
  }, [v, phase]);
  return { doc, ...st };
}

// ---- words ----

export const everyLabel = (e: Every) => (e === "day" ? t("Daily") : e === "week" ? t("Weekly") : t("Monthly"));

const cap = (s: string) => s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1);
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Due now", or when it comes next: "Next: tomorrow", "Next: Monday", "Next: 1 December". */
export function dueLabel(r: Review, d: ReviewDoc, now = new Date()): string {
  if (isDue(r, d, now)) return t("Due now");
  const next = nextDue(r, d, now);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const when = sameDay(next, tomorrow) ? t("tomorrow")
    : next.getTime() - now.getTime() < 7 * 86_400_000 ? next.toLocaleDateString(locale(), { weekday: "long" })
    : next.toLocaleDateString(locale(), { day: "numeric", month: "long" });
  return t("Next: {when}", { when });
}

/** The period a story is from: "Today", "This week", "November". */
export function periodLabel(e: Every, now = new Date()): string {
  return e === "day" ? t("Today") : e === "week" ? t("This week") : cap(now.toLocaleDateString(locale(), { month: "long" }));
}

/** The end slide's line: "Next one tomorrow", "… next week", "… next month". */
export const nextOneLabel = (e: Every) => (e === "day" ? t("Next one tomorrow") : e === "week" ? t("Next one next week") : t("Next one next month"));

onWipe(() => { wipes++; doc = emptyDoc(); version = 0; loaded = false; loading = null; runs.clear(); checks.clear(); found.clear(); bump(); });
