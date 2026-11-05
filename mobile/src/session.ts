// Who is signed in, and whether the library is unlocked. The master key lives in memory only, plus (if the person
// chose it) in the phone's hardware keystore, released only after a fingerprint or face check.
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { getSodium, b64, unb64 } from "@crypto/sodium";
import { loginProof, normEmail, unlockMasterKey } from "@crypto/account";
import { open, LABEL } from "@crypto/wrap";
import type { KdfParams } from "@crypto/kdf";
import { api, ApiError, remote, setCsrf, setServer, whenRevoked, whenSessionEnds } from "./api";

export interface Me {
  user: { id: string; email: string; role: "admin" | "user"; nsfw?: boolean };
  csrf: string;
  kdf: KdfParams;
  wrapped_master_pw: string;
  wrapped_privkey: string;
  pubkey: string;
  /** this phone in the device list, and the device that computes the search index ("" = none yet; docs/SEARCH.md) */
  session_id?: string;
  indexer?: string;
}

type Phase = "starting" | "noServer" | "signedOut" | "locked" | "unlocked";
interface State {
  phase: Phase; server: string; me: Me | null; masterKey: Uint8Array | null; biometric: boolean; notice?: string;
  /** locked with "Lock now": the unlock screen then waits for a tap instead of asking for the fingerprint at once */
  byHand?: boolean;
}

let state: State = { phase: "starting", server: "", me: null, masterKey: null, biometric: false };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };

/** Everything derived from the master key (item keys, decrypted names and images) registers here and is wiped at
 *  every lock, sign-out, session end or server change, not in one screen. "ended" is everything but a plain lock. */
type Wipe = (how: "locked" | "ended") => void;
const wipers = new Set<Wipe>();
export const onWipe = (f: Wipe) => { wipers.add(f); };
function wipe(how: "locked" | "ended") {
  for (const f of wipers) { try { f(how); } catch { /* keep wiping the rest */ } }
}

/** What this phone keeps for the account beyond the key (backup and search settings, the session cookie) registers
 *  here and is deleted at sign-out, not when the server ends the session (the backup goes on after signing in again). */
const signOuts = new Set<() => Promise<void> | void>();
export const onSignOut = (f: () => Promise<void> | void) => { signOuts.add(f); };
async function forgetAccount() {
  for (const f of signOuts) { try { await f(); } catch { /* keep deleting the rest */ } }
}

/** Called whenever who the phone's session belongs to may have changed (a session end, a sign-in, another account,
 *  another server): work running for the account before (the backup) stops before its next request. */
const handovers = new Set<() => void>();
export const onSessionChange = (f: () => void) => { handovers.add(f); };
function handedOver() {
  for (const f of handovers) { try { f(); } catch { /* tell the rest */ } }
}

export const useSession = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
export const session = () => state;

const SERVER = "cf.server";
/** The server the app uses, as stored: the background jobs run only for that one. */
export const savedServer = async () => (await SecureStore.getItemAsync(SERVER)) ?? "";
const keyName = (userId: string) => `cf.mk.${userId}`; // only letters, digits, ".", "-", "_" are allowed
const bioName = (userId: string) => `cf.bio.${userId}`;
const bioNoName = (userId: string) => `cf.bioNo.${userId}`; // "Not now" to fingerprint unlock: not offered again
const PROMPT = "Unlock Cipherfilm";

/** Same bounds as the server and the web client: a server can't talk the app into weak or absurd Argon2 settings. */
function assertSaneKdf(k: KdfParams) {
  if (!(k.ops >= 2 && k.ops <= 10 && k.mem >= 32 * 1024 * 1024 && k.mem <= 1024 * 1024 * 1024)) {
    throw new Error("The server sent unexpected password-hashing settings. Sign-in was stopped for your safety.");
  }
}

/** A master key is only accepted if it opens something the server keeps sealed under it. */
async function checkKey(me: Me, key: Uint8Array): Promise<boolean> {
  const s = await getSodium();
  try {
    const priv = open(s, unb64(s, me.wrapped_privkey), key, LABEL.privkey, normEmail(me.user.email));
    s.memzero(priv);
    return true;
  } catch {
    return false;
  }
}

function adopt(me: Me, masterKey: Uint8Array | null) {
  if (state.me && state.me.user.id !== me.user.id) { wipe("ended"); handedOver(); }
  setCsrf(me.csrf);
  set({ me, masterKey, phase: masterKey ? "unlocked" : "locked", notice: undefined, byHand: false });
}

whenSessionEnds(() => {
  if (state.phase === "unlocked" || state.phase === "locked") {
    wipe("ended");
    handedOver();
    if (state.masterKey) state.masterKey.fill(0);
    set({ phase: "signedOut", me: null, masterKey: null, notice: "Your session ended. Sign in again." });
  }
});

/** Signed out from another device (web, Account › Devices): as at sign-out, minus telling the server. */
async function revoked() {
  const me = state.me;
  if (me) {
    await SecureStore.deleteItemAsync(keyName(me.user.id));
    await SecureStore.deleteItemAsync(bioName(me.user.id));
    await SecureStore.deleteItemAsync(bioNoName(me.user.id));
  }
  wipe("ended");
  await forgetAccount();
  if (state.masterKey) state.masterKey.fill(0);
  setCsrf("");
  set({ phase: "signedOut", me: null, masterKey: null, biometric: false, notice: "This phone was signed out from another device. What it kept of your library was deleted." });
}
let revoking = false;
whenRevoked(() => { if (!revoking) { revoking = true; revoked().finally(() => { revoking = false; }); } });

/** Fetches the account again (an admin may have allowed explicit search, another device may index now). */
export async function refreshMe(): Promise<Me | null> {
  if (!state.me) return null;
  const me = await api<Me>("GET", "/api/me");
  if (state.me?.user.id !== me.user.id) return state.me;
  setCsrf(me.csrf);
  set({ me });
  return me;
}

export async function start() {
  const server = (await SecureStore.getItemAsync(SERVER)) ?? "";
  if (!server) return set({ phase: "noServer" });
  setServer(server);
  set({ server });
  try {
    const me = await api<Me>("GET", "/api/me");
    adopt(me, null);
    set({ biometric: (await SecureStore.getItemAsync(bioName(me.user.id))) === "1" });
  } catch (e) {
    // offline with a session we can't check: still offer sign-in; the error shows when they try
    set({ phase: "signedOut", notice: e instanceof ApiError && e.status === 0 ? e.message : undefined });
  }
}

/** Checks that the address answers like a Cipherfilm before remembering it. */
export async function chooseServer(input: string) {
  let origin = input.trim();
  if (!/^https?:\/\//i.test(origin)) origin = "https://" + origin;
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error("That isn't a web address."); }
  if (url.protocol !== "https:") throw new Error("Cipherfilm needs an https address.");
  try {
    await api("GET", "/api/setup/status", undefined, remote(url.origin)); // the app's server stays until this one answers
  } catch (e) {
    throw e instanceof ApiError && e.status === 0 ? e : new Error("That address answers, but not like a Cipherfilm.");
  }
  // another server: what the phone keeps for the account on the old one (backup, background search) ends too
  if (url.origin !== (await savedServer())) await forgetAccount();
  handedOver();
  setServer(url.origin);
  await SecureStore.setItemAsync(SERVER, url.origin);
  wipe("ended");
  setCsrf("");
  set({ server: url.origin, phase: "signedOut", me: null, masterKey: null, notice: undefined });
}

export async function forgetServer() {
  wipe("ended");
  await forgetAccount();
  handedOver();
  setServer("");
  setCsrf("");
  await SecureStore.deleteItemAsync(SERVER);
  set({ phase: "noServer", server: "", me: null, masterKey: null });
}

export async function login(email: string, password: string) {
  const s = await getSodium();
  const e = normEmail(email);
  setServer(state.server); // the server shown on the sign-in screen, always
  const kdf = await api<KdfParams>("GET", `/api/auth/params?email=${encodeURIComponent(e)}`);
  assertSaneKdf(kdf);
  const { auth, kek } = await loginProof(s, password, kdf);
  const me = await api<Me>("POST", "/api/auth/login", { email: e, auth });
  handedOver(); // the cookie is this account's now
  adopt(me, unlockMasterKey(s, e, kek, me.wrapped_master_pw));
  s.memzero(kek);
  set({ biometric: (await SecureStore.getItemAsync(bioName(me.user.id))) === "1" });
}

/** After a reload the session cookie is still valid; only the password (or a fingerprint) is needed for the keys. */
export async function unlockWithPassword(password: string) {
  const s = await getSodium();
  const me = state.me!;
  assertSaneKdf(me.kdf);
  const { kek } = await loginProof(s, password, me.kdf);
  let key: Uint8Array;
  try {
    key = unlockMasterKey(s, me.user.email, kek, me.wrapped_master_pw);
  } catch {
    throw new Error("That password isn't right.");
  } finally {
    s.memzero(kek);
  }
  adopt(me, key);
}

export const biometricPossible = () => SecureStore.canUseBiometricAuthentication();

/** After a password: offer fingerprint unlock, unless it is on, not possible, or the person said "Not now" before. */
export async function offerBiometric() {
  const { me, biometric } = state;
  if (!me || biometric || !biometricPossible()) return false;
  return (await SecureStore.getItemAsync(bioNoName(me.user.id))) !== "1";
}
export async function declineBiometric() {
  if (state.me) await SecureStore.setItemAsync(bioNoName(state.me.user.id), "1");
}

/** Stores the master key in the hardware keystore, readable only after a fingerprint or face check. */
export async function enableBiometric() {
  const s = await getSodium();
  const { me, masterKey } = state;
  if (!me || !masterKey) throw new Error("Unlock your library first.");
  await SecureStore.setItemAsync(keyName(me.user.id), b64(s, masterKey), { requireAuthentication: true, authenticationPrompt: PROMPT });
  await SecureStore.setItemAsync(bioName(me.user.id), "1");
  set({ biometric: true });
}

export async function disableBiometric() {
  const me = state.me;
  if (!me) return;
  await SecureStore.deleteItemAsync(keyName(me.user.id));
  await SecureStore.deleteItemAsync(bioName(me.user.id));
  set({ biometric: false });
}

/** Returns false when the person cancelled; throws when the stored key no longer works (new fingerprint added). */
export async function unlockWithBiometric(): Promise<boolean> {
  const s = await getSodium();
  const me = state.me!;
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(keyName(me.user.id), { requireAuthentication: true, authenticationPrompt: PROMPT });
  } catch (e) {
    if (/cancel/i.test(String((e as Error).message))) return false;
    await disableBiometric(); // the system invalidated the key, e.g. after a new fingerprint was added
    throw new Error("Fingerprint unlock was reset by the phone. Unlock with your password, then turn it on again.");
  }
  if (!stored) { await disableBiometric(); throw new Error("Unlock with your password."); }
  const key = unb64(s, stored);
  if (!(await checkKey(me, key))) {
    s.memzero(key);
    await disableBiometric();
    throw new Error("The saved key doesn't fit this account anymore. Unlock with your password.");
  }
  adopt(me, key);
  return true;
}

/** Locks the library: the key leaves memory; the session stays. */
export function lock(byHand = false) {
  wipe("locked");
  if (state.masterKey) state.masterKey.fill(0);
  if (state.me) set({ masterKey: null, phase: "locked", byHand });
}

export async function signOut() {
  const me = state.me;
  try { await api("POST", "/api/auth/logout"); } catch { /* signed out locally either way */ }
  if (me) {
    await SecureStore.deleteItemAsync(keyName(me.user.id));
    await SecureStore.deleteItemAsync(bioName(me.user.id));
    await SecureStore.deleteItemAsync(bioNoName(me.user.id));
  }
  wipe("ended");
  await forgetAccount();
  if (state.masterKey) state.masterKey.fill(0);
  setCsrf("");
  set({ phase: "signedOut", me: null, masterKey: null, biometric: false, notice: undefined });
}
