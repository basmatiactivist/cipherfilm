// Custom reviews' notifications (docs/MEMORIES.md "Custom reviews"): the background task (backup.ts) has no master key
// and can't open the reviews document, so the app keeps a small schedule on the phone, in its private files, whenever
// it loads or saves the document or plays a review: per review only its id, how often it comes, whether it notifies,
// the period it was last watched in, whether its search found anything here, and whether it passed the Play build's
// check. No names, no searches, no photos. The background posts one generic notification ("A review is ready") when
// one is due, once per review and period, in the daytime. Deleted at sign-out.
import { AppState } from "react-native";
import { File, Paths } from "expo-file-system";
import { EVERY, periodOf, type Every, type ReviewDoc } from "@memories/custom";
import N from "../modules/cf-native/src/CfNativeModule";
import { memoriesOn } from "./memories";
import { onSignOut, onWipe } from "./session";
import { t, tn } from "./i18n";

export interface Entry {
  id: string;
  every: Every;
  notify: boolean;
  /** the period it was last watched in (periodOf), -1 for never */
  period: number;
  /** its search found something on this phone, the last time the app ran it */
  hasMatches: boolean;
  /** passed the Play build's explicit-word check (always true outside it) */
  ok: boolean;
  /** the review's `updated` that check was made for: an edit (here or on another device) needs a new one */
  checked?: number;
}
export interface Schedule { v: 1; entries: Entry[]; /** review id → the period it was notified for */ notified: Record<string, number> }

export const emptySchedule = (): Schedule => ({ v: 1, entries: [], notified: {} });
/** The hours a notification may come in (local time): from 9:00 to 20:59. */
export const FIRST_HOUR = 9;
export const LAST_HOUR = 20;

export function readSchedule(raw: unknown): Schedule {
  const s = emptySchedule();
  const r = raw as Partial<Schedule> | null;
  if (!r || typeof r !== "object") return s;
  if (Array.isArray(r.entries)) {
    s.entries = r.entries.filter((e): e is Entry => !!e && typeof e.id === "string" && EVERY.includes(e.every) && Number.isFinite(e.period))
      .map((e) => ({ id: e.id, every: e.every, notify: e.notify === true, period: e.period, hasMatches: e.hasMatches === true, ok: e.ok === true, ...(Number.isFinite(e.checked) ? { checked: e.checked } : {}) }));
  }
  if (r.notified && typeof r.notified === "object") for (const [k, v] of Object.entries(r.notified)) if (Number.isFinite(v)) s.notified[k] = v;
  return s;
}

/** What this phone learnt about a review while the app was open: whether its search found anything, and the Play
 *  check's answer for the review as it was then (`checked`: its `updated`). */
export interface Facts { hasMatches?: boolean; ok?: boolean; checked?: number }

/** The schedule for the document as it is now, keeping what was learnt before (unless the review changed since). */
export function scheduleFor(doc: ReviewDoc, prev: Schedule, facts: Record<string, Facts> = {}, play = false): Schedule {
  const old = new Map(prev.entries.map((e) => [e.id, e]));
  const entries = doc.reviews.map((r): Entry => {
    const o = old.get(r.id), f = facts[r.id] ?? {};
    const checked = f.ok !== undefined ? f.checked : o?.checked;
    const ok = !play || (f.ok !== undefined ? f.ok && f.checked === r.updated : !!o?.ok && o.checked === r.updated);
    return {
      id: r.id, every: r.every, notify: r.notify, period: doc.shown[r.id]?.period ?? -1,
      hasMatches: f.hasMatches ?? !!o?.hasMatches, ok,
      ...(checked !== undefined && Number.isFinite(checked) ? { checked } : {}),
    };
  });
  const ids = new Set(entries.map((e) => e.id));
  const notified: Record<string, number> = {};
  for (const [k, v] of Object.entries(prev.notified)) if (ids.has(k)) notified[k] = v;
  return { v: 1, entries, notified };
}

/** Due now and allowed to notify: switched on, found something here, passed the check, not watched this period. */
const eligible = (s: Schedule, now: Date) => s.entries.filter((e) => e.notify && e.hasMatches && e.ok && periodOf(e.every, now) > e.period);

/**
 * What the background posts now: ids, the reviews not notified yet for their period (nothing outside 9:00–20:59),
 * and count, all that are due (the notification's number). A notification only when ids isn't empty.
 */
export function dueToNotify(s: Schedule, now: Date): { ids: string[]; count: number } {
  const due = eligible(s, now);
  const h = now.getHours();
  if (h < FIRST_HOUR || h > LAST_HOUR) return { ids: [], count: due.length };
  return { ids: due.filter((e) => s.notified[e.id] !== periodOf(e.every, now)).map((e) => e.id), count: due.length };
}

/** Remembers that these were notified for their current period. */
export function markNotified(s: Schedule, ids: string[], now: Date): Schedule {
  const notified = { ...s.notified };
  for (const e of s.entries) if (ids.includes(e.id)) notified[e.id] = periodOf(e.every, now);
  return { ...s, notified };
}

/** The notification's words: generic, so neither the lock screen nor anyone near learns what a review is about. */
export const notifyTitle = (count: number) => tn(count, "A review is ready", "{n} reviews are ready");

// ---- the file ----

const FILE = () => new File(Paths.document, "reviews-schedule.json");

export async function loadSchedule(): Promise<Schedule> {
  try { const f = FILE(); return f.exists ? readSchedule(JSON.parse(await f.text())) : emptySchedule(); } catch { return emptySchedule(); }
}

let writing: Promise<unknown> = Promise.resolve();
/** Changes the file, one change after the other. */
export function updateSchedule(f: (s: Schedule) => Schedule): Promise<void> {
  const next = writing.catch(() => {}).then(async () => { await FILE().write(JSON.stringify(f(await loadSchedule()))); });
  writing = next;
  return next.catch(() => { /* next time */ });
}

/** Whether the background task should run for the reviews: Memories on and some review notifies. */
export function reviewNoticesWanted(): boolean {
  if (!memoriesOn()) return false;
  try { const f = FILE(); return f.exists && readSchedule(JSON.parse(f.textSync())).entries.some((e) => e.notify && e.ok); } catch { return false; }
}

export function clearSchedule() {
  try { const f = FILE(); if (f.exists) f.delete(); } catch { /* gone */ }
  try { N.reviewCancel?.(); } catch { /* older native build */ }
}

/** A review was watched, or none is due any more: its notification goes. */
export function cancelReviewNotice() {
  try { N.reviewCancel?.(); } catch { /* older native build */ }
}

/** The background task's part (after checkNotices): one notification when a review is newly due. */
export async function checkReviews(now = new Date()): Promise<boolean> {
  if (!memoriesOn() || AppState.currentState === "active") return false;
  const s = await loadSchedule();
  const { ids, count } = dueToNotify(s, now);
  if (!ids.length) return false;
  let shown = false;
  try { shown = !!N.reviewShow?.(notifyTitle(count), t("Tap to watch."), "Cipherfilm"); } catch { /* older native build */ }
  // not allowed by Android now: tried again at the next run
  if (shown) await updateSchedule((x) => markNotified(x, ids, now));
  return shown;
}

// nothing of the account stays: at sign-out, and when the session ends (another account may sign in next)
onSignOut(clearSchedule);
onWipe((how) => { if (how === "ended") clearSchedule(); });
