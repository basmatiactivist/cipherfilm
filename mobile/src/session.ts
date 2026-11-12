// Who is signed in, and whether the library is unlocked. The master key lives in memory only, plus (if the person
// chose it) in the phone's hardware keystore, released only after a fingerprint or face check.
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { getSodium, b64, unb64 } from "@crypto/sodium";
import { loginProof, normEmail, unlockMasterKey } from "@crypto/account";
import { open, LABEL } from "@crypto/wrap";
import type { KdfParams } from "@crypto/kdf";
import { api, ApiError, remote, setCsrf, setServer, whenRevoked, whenSessionEnds } from "./api";
import { t } from "./i18n";
import { codeProblem, methods, pendingToken, withStep, type Step } from "./twoStep";
import { getPasskey } from "./passkeys";

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
  /** the server's version (older servers don't send it) */
  server_version?: string;
  /** the server's public demo login (DEMO_ACCOUNTS): it reads and searches, every change is refused */
  demo?: boolean;
  /** the map tab's base map styles (light, dark: tried in order); absent when the server turned the map off */
  map?: { light: string[]; dark: string[] };
  /** two-step sign-in is on: a new sign-in asks for a code after the password (older servers don't send it) */
  two_factor?: boolean;
}

type Phase = "starting" | "noServer" | "signedOut" | "locked" | "unlocked";
interface State {
  phase: Phase; server: string; me: Me | null; masterKey: Uint8Array | null; biometric: boolean; notice?: string;
  /** locked with "Lock now" or by shaking: the unlock screen then waits for a tap instead of asking for the
   *  fingerprint at once (the phone may be in someone else's hand) */
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
const prompt = () => t("Unlock Cipherfilm");

/** Same bounds as the server and the web client: a server can't talk the app into weak or absurd Argon2 settings. */
export function assertSaneKdf(k: KdfParams) {
  const ok = k.alg === "argon2id13" && k.v === 1 && Number.isInteger(k.ops) && Number.isInteger(k.mem)
    && k.ops >= 2 && k.ops <= 10 && k.mem >= 32 * 1024 * 1024 && k.mem <= 1024 * 1024 * 1024
    && typeof k.salt === "string" && /^[A-Za-z0-9_-]{22}$/.test(k.salt); // 16 bytes, base64url
  if (!ok) {
    throw new Error(t("The server sent unexpected password settings. Sign-in stopped for your safety."));
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
    set({ phase: "signedOut", me: null, masterKey: null, notice: t("Your session ended. Sign in again.") });
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
  set({ phase: "signedOut", me: null, masterKey: null, biometric: false, notice: t("This phone was signed out from another device. Its copy of your library was deleted.") });
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
  try { url = new URL(origin); } catch { throw new Error(t("That isn't a web address.")); }
  if (url.protocol !== "https:") throw new Error(t("Cipherfilm needs an https address."));
  try {
    await api("GET", "/api/setup/status", undefined, remote(url.origin)); // the app's server stays until this one answers
  } catch (e) {
    throw e instanceof ApiError && e.status === 0 ? e : new Error(t("That address isn't a Cipherfilm server."));
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

/** The second step of a sign-in to an account with two-step sign-in: the password was right, the server now wants a
 *  code (from the authenticator app, or a recovery code). It holds the key derived from the password until the code
 *  is accepted or the person starts over; nothing of the account (session, keys) is on the phone before that. */
export interface CodeStep {
  /** Which second steps the account has: an authenticator app, a passkey for this server (an older server: the app). */
  totp: boolean;
  passkey: boolean;
  /** Sends the code; signs in when it is right. Throws CodeExpired when the password is needed again. */
  finish(code: string): Promise<void>;
  /** The same with a passkey: Android asks for it, the server checks its answer to this sign-in's challenge. */
  usePasskey(): Promise<void>;
  /** Starting over: the key derived from the password is overwritten. */
  cancel(): void;
}

/** The sign-in waiting for a code ended (too old, too many wrong codes, the password changed): sign in again. */
export class CodeExpired extends Error {}

async function signedIn(s: Awaited<ReturnType<typeof getSodium>>, e: string, kek: Uint8Array, me: Me) {
  handedOver(); // the cookie is this account's now
  try {
    adopt(me, unlockMasterKey(s, e, kek, me.wrapped_master_pw));
  } finally {
    s.memzero(kek);
  }
  set({ biometric: (await SecureStore.getItemAsync(bioName(me.user.id))) === "1" });
}

function codeStep(s: Awaited<ReturnType<typeof getSodium>>, e: string, kek: Uint8Array, pending: string, has: { totp: boolean; passkey: boolean }): CodeStep {
  let open = true;
  const cancel = () => { if (open) { open = false; s.memzero(kek); } };
  const expired = () => new CodeExpired(t("This sign-in expired. Enter your password again."));
  const send = async (second: { code: string } | { passkey: Record<string, unknown> }, wrong: string) => {
    let me: Me;
    try {
      me = await api<Me>("POST", "/api/auth/login/2fa", { pending, ...second });
    } catch (err) {
      const why = codeProblem(err);
      if (why === "expired") { cancel(); throw expired(); }
      if (why === "wrong") throw new Error(wrong);
      throw err;
    }
    open = false;
    await signedIn(s, e, kek, me);
  };
  return {
    ...has,
    cancel,
    async finish(code: string) {
      if (!open) throw expired();
      await send({ code }, t("That code isn't right. Try again."));
    },
    async usePasskey() {
      if (!open) throw expired();
      let options: Record<string, unknown>;
      try {
        ({ options } = await api<{ options: Record<string, unknown> }>("POST", "/api/auth/login/2fa/passkey", { pending }));
      } catch (err) {
        if (codeProblem(err) === "expired") { cancel(); throw expired(); }
        throw err;
      }
      const passkey = await getPasskey(options);
      if (!open) throw expired();
      await send({ passkey }, t("That passkey wasn't accepted. Try again, or use a code."));
    },
  };
}

/** Signs in; returns a code step when the account has two-step sign-in (null when already signed in). */
export async function login(email: string, password: string): Promise<CodeStep | null> {
  const s = await getSodium();
  const e = normEmail(email);
  setServer(state.server); // the server shown on the sign-in screen, always
  const kdf = await api<KdfParams>("GET", `/api/auth/params?email=${encodeURIComponent(e)}`);
  assertSaneKdf(kdf);
  const { auth, kek } = await loginProof(s, password, kdf);
  let me: Me;
  try {
    me = await api<Me>("POST", "/api/auth/login", { email: e, auth });
  } catch (err) {
    const pending = pendingToken(err);
    if (!pending) { s.memzero(kek); throw err; }
    return codeStep(s, e, kek, pending, methods(err));
  }
  await signedIn(s, e, kek, me);
  return null;
}

/** The sign-in proof for the signed-in account, after checking the password here first (a typo shows at once):
 *  what changing two-step sign-in sends to the server. */
export async function passwordProof(password: string): Promise<string> {
  const s = await getSodium();
  const me = state.me;
  if (!me) throw new Error(t("Sign in first."));
  assertSaneKdf(me.kdf);
  const { auth, kek } = await loginProof(s, password, me.kdf);
  try {
    s.memzero(unlockMasterKey(s, me.user.email, kek, me.wrapped_master_pw));
  } catch {
    throw new Error(t("That password isn't right."));
  } finally {
    s.memzero(kek);
  }
  return auth;
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
    throw new Error(t("That password isn't right."));
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
  if (!me || !masterKey) throw new Error(t("Unlock your library first."));
  await SecureStore.setItemAsync(keyName(me.user.id), b64(s, masterKey), { requireAuthentication: true, authenticationPrompt: prompt() });
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
    stored = await SecureStore.getItemAsync(keyName(me.user.id), { requireAuthentication: true, authenticationPrompt: prompt() });
  } catch (e) {
    if (/cancel/i.test(String((e as Error).message))) return false;
    await disableBiometric(); // the system invalidated the key, e.g. after a new fingerprint was added
    throw new Error(t("The phone reset fingerprint unlock. Unlock with your password, then turn it on again."));
  }
  if (!stored) { await disableBiometric(); throw new Error(t("Unlock with your password.")); }
  const key = unb64(s, stored);
  if (!(await checkKey(me, key))) {
    s.memzero(key);
    await disableBiometric();
    throw new Error(t("The saved key no longer fits this account. Unlock with your password."));
  }
  adopt(me, key);
  return true;
}

/** Locks the library: the key leaves memory; the session stays. byHand: "Lock now" or shaking, see State. */
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

/** Deletes the account and everything in it from the server, permanently (Account › Delete account), after checking the
 *  password here first. Then the phone forgets everything, as at sign-out. The server refuses for its only admin.
 *  While two-step sign-in is on, `second` gives the second step, asked for only once the password is right. */
export async function deleteAccount(password: string, second?: () => Promise<Step>) {
  const s = await getSodium();
  const me = state.me;
  if (!me) throw new Error(t("Sign in first."));
  assertSaneKdf(me.kdf);
  const { auth, kek } = await loginProof(s, password, me.kdf);
  try {
    s.memzero(unlockMasterKey(s, me.user.email, kek, me.wrapped_master_pw));
  } catch {
    throw new Error(t("That password isn't right."));
  } finally {
    s.memzero(kek);
  }
  await api("DELETE", "/api/me", withStep({ current_auth: auth }, second ? await second() : null));
  await SecureStore.deleteItemAsync(keyName(me.user.id));
  await SecureStore.deleteItemAsync(bioName(me.user.id));
  await SecureStore.deleteItemAsync(bioNoName(me.user.id));
  wipe("ended");
  await forgetAccount();
  handedOver();
  if (state.masterKey) state.masterKey.fill(0);
  setCsrf("");
  set({ phase: "signedOut", me: null, masterKey: null, biometric: false, notice: t("Your account and everything in it were deleted from the server.") });
}

/** Shown wherever a demo login looks at its photos, so nobody takes it for their own library. */
export const demoNote = () => t("Public demo · read-only · resets every hour");
