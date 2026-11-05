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

export async function loadSettings(): Promise<SearchSettings> {
  if (cached) return cached;
  try {
    const f = FILE();
    cached = f.exists ? { ...DEFAULTS, ...JSON.parse(await f.text()) } : { ...DEFAULTS };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached!;
}

export async function saveSettings(patch: Partial<SearchSettings>): Promise<SearchSettings> {
  const next = { ...(await loadSettings()), ...patch };
  DIR().create({ intermediates: true, idempotent: true });
  await FILE().write(JSON.stringify(next));
  cached = next;
  subs.forEach((f) => f());
  return next;
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
  cached = null;
  subs.forEach((f) => f());
}
