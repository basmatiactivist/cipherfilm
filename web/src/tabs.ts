// The tabs of a browser share one session cookie. A sign-out in one tab ends the session the others use, and a sign-in
// replaces it: the other tabs are told (BroadcastChannel, or a localStorage event where that is missing) and forget
// what they hold, without asking the server.
import type { Me } from "./state";

export type TabSignal =
  /** a session ended: session absent means every session of the account (the account was deleted) */
  | { t: "signed-out"; user: string; session?: string }
  /** an account signed in: the cookie now belongs to its new session */
  | { t: "signed-in"; user: string; session?: string };

const NAME = "cf-tabs";

/** The same account and, where both sides know it, the same session. */
export const sameSession = (held: Me | null, user: string, session?: string): boolean =>
  !!held && held.user.id === user && (!held.session_id || !session || held.session_id === session);

/** Whether a tab holding `held` must forget it on this signal from another tab. */
export function endsHere(s: TabSignal, held: Me | null): boolean {
  if (!held) return false; // nothing held: nothing to forget
  if (s.t === "signed-in") return true; // the cookie this tab relied on is gone, also for the same account
  return sameSession(held, s.user, s.session); // a late sign-out of an older session leaves a newer one alone
}

interface Env {
  BroadcastChannel?: typeof BroadcastChannel;
  localStorage?: Storage;
  addEventListener?: (type: "storage", f: (e: StorageEvent) => void) => void;
  removeEventListener?: (type: "storage", f: (e: StorageEvent) => void) => void;
}
const env = (): Env => (typeof window !== "undefined" ? (window as unknown as Env) : (globalThis as unknown as Env));

const parse = (v: unknown): TabSignal | null => {
  const s = (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v) as TabSignal | null;
  return s && (s.t === "signed-out" || s.t === "signed-in") && typeof s.user === "string" ? s : null;
};

let channel: BroadcastChannel | null = null;
const chan = (e: Env) => (channel ??= new e.BroadcastChannel!(NAME));

/** Tells the other tabs of this origin (never this one). */
export function announce(s: TabSignal, e: Env = env()): void {
  try {
    if (e.BroadcastChannel) { chan(e).postMessage(s); return; }
    // a storage event reaches the other tabs only when the value changes: the time makes each one new
    e.localStorage?.setItem(NAME, JSON.stringify({ ...s, at: Date.now() + Math.random() }));
    e.localStorage?.removeItem(NAME);
  } catch { /* no way to tell them: their next request finds out (api.ts) */ }
}

/** Calls f for every signal another tab announces, until the returned function is called. */
export function onAnnounce(f: (s: TabSignal) => void, e: Env = env()): () => void {
  if (e.BroadcastChannel) {
    // the one channel announce() sends on: a channel never hears its own messages, so this tab doesn't hear itself
    const c = chan(e);
    const on = (m: MessageEvent) => { const s = parse(m.data); if (s) f(s); };
    c.addEventListener("message", on);
    return () => c.removeEventListener("message", on);
  }
  const on = (m: StorageEvent) => { if (m.key === NAME && m.newValue) { const s = parse(m.newValue); if (s) f(s); } };
  e.addEventListener?.("storage", on);
  return () => e.removeEventListener?.("storage", on);
}

/** For the tests: forgets the channel this tab opened. */
export function resetTabs(): void { channel?.close(); channel = null; }
