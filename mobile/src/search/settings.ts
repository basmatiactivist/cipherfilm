// Search settings of this phone. Search is opt-in: the app asks once after unlocking, and Account › Search and people
// changes it any time. Like the backup, the background indexer keeps the account's public key (checked against the
// private key when search was turned on), so it can add index entries but never read any.
import { Directory, File, Paths } from "expo-file-system";
import { getSodium, b64, unb64 } from "@crypto/sodium";
import { accountKeyPair } from "@crypto/item";
import { normEmail } from "@crypto/account";

export interface SearchSettings {
  enabled: boolean;
  /** find faces and group them into people */
  faces: boolean;
  /** index photos on this phone in the background too, not only while the app is open */
  background: boolean;
  /** background indexing only while charging */
  chargingOnly: boolean;
  /** download the models only on Wi-Fi */
  wifiOnly: boolean;
  /** the question after unlocking was answered */
  asked: boolean;
  server?: string; userId?: string; pubkey?: string;
  /** the model the account uses (written by the app; the background, without the master key, follows it) */
  clip?: "mobileclip-s2" | "laion-b32";
  /** false: another device computes the index, this phone only searches (the background then does nothing) */
  indexes?: boolean;
}

const DEFAULTS: SearchSettings = { enabled: false, faces: true, background: true, chargingOnly: true, wifiOnly: true, asked: false };

const DIR = () => new Directory(Paths.document, "search");
const FILE = () => new File(DIR(), "settings.json");

const subs = new Set<() => void>();
export const onSettingsChange = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

let cached: SearchSettings | null = null;
let reading: Promise<SearchSettings> | null = null;
let writing: Promise<unknown> = Promise.resolve();
let forgotten = 0; // counts sign-outs: a read still going then keeps nothing

/** One read of the file at a time: two that overlapped could each set the cache, the later one with what was in the
 *  file before a save that came in between ("asked" lost, the search question shown again). */
export function loadSettings(): Promise<SearchSettings> {
  if (cached) return Promise.resolve(cached);
  const gen = forgotten;
  reading ??= (async () => {
    let v: SearchSettings;
    try {
      const f = FILE();
      v = f.exists ? { ...DEFAULTS, ...JSON.parse(await f.text()) } : { ...DEFAULTS };
    } catch {
      v = { ...DEFAULTS };
    }
    if (gen === forgotten) cached ??= v;
    return cached ?? v;
  })().finally(() => { reading = null; });
  return reading;
}

/** Saves one after the other, each on top of the last: two at once would otherwise lose one's change. */
export function saveSettings(patch: Partial<SearchSettings>): Promise<SearchSettings> {
  const done = writing.catch(() => {}).then(async () => {
    const next = { ...(await loadSettings()), ...patch };
    DIR().create({ intermediates: true, idempotent: true });
    await FILE().write(JSON.stringify(next));
    cached = next;
    subs.forEach((f) => f());
    return next;
  });
  writing = done;
  return done;
}

let offered = false;
let answered = false;
/** Whether to ask "Search your photos?" now: true only for the first caller while search is off and the question
 *  wasn't answered yet. A library screen that checks again (its effect running once more, or a second one mounted)
 *  while the question is open doesn't ask again. "asked" is saved with the answer (answerOffer); a screen that goes
 *  away before showing or answering it gives the question back (releaseOffer), so it is still asked. */
export async function claimOffer(): Promise<boolean> {
  const s = await loadSettings();
  if (offered || s.asked || s.enabled) return false;
  offered = true;
  return true;
}

export function releaseOffer() { if (!answered) offered = false; }

export async function answerOffer() {
  answered = true;
  await saveSettings({ asked: true }).catch(() => { /* asked in this run anyway */ });
}

/** Pins the account's public key for the background indexer after checking it against the private key. */
export async function pinAccount(me: { user: { id: string; email: string }; pubkey: string; wrapped_privkey: string }, server: string, master: Uint8Array) {
  const s = await getSodium();
  const pair = accountKeyPair(s, unb64(s, me.wrapped_privkey), master, normEmail(me.user.email));
  s.memzero(pair.sk);
  if (!s.memcmp(pair.pk, unb64(s, me.pubkey))) throw new Error("Your account's keys don't match. Search was not turned on.");
  return { server, userId: me.user.id, pubkey: b64(s, pair.pk) };
}

export const settingsDir = DIR;

/** Sign-out: the settings, the pinned key and what was indexed in the background go (the models stay). */
export function forgetSettings() {
  try { const d = DIR(); if (d.exists) d.delete(); } catch { /* best effort */ }
  cached = null; offered = false; answered = false; forgotten++;
  subs.forEach((f) => f());
}
