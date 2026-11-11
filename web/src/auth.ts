import { api, ApiError, dropRequests, setCsrf } from "./api";
import { getSodium } from "./crypto/sodium";
import {
  createAccount, finishRecovery, type NewAccount, newRecoveryKit, loginProof, normEmail, recoveryProof, rewrapForPassword,
  unlockMasterKey, unlockWithRecovery,
} from "./crypto/account";
import type { KdfParams } from "./crypto/kdf";
import { dropMasterKey, mem, Me } from "./state";
import { clearCaches } from "./cache";
import { clearPeople } from "./people/people";
import { clearPlayer } from "./player";
import { clearUploadMemory, forgetDecrypted } from "./items";
import { forgetKeptForGood, keepKey, keptKey } from "./keep";
import { open, LABEL } from "./crypto/wrap";
import { announce, sameSession } from "./tabs";

/** Give the browser a frame to paint a busy state before Argon2 blocks the thread. */
export const paint = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** A server could hand out weak or absurd KDF settings; refuse anything outside the range the server itself enforces. */
function assertSaneKdf(k: KdfParams) {
  if (!(k.ops >= 2 && k.ops <= 10 && k.mem >= 32 * 1024 * 1024 && k.mem <= 1024 * 1024 * 1024)) {
    throw new Error("The server sent unexpected password settings. Sign-in stopped for your safety.");
  }
}

/** The server's version, for the sign-in screen ("" until the setup status or a session reported it). */
export let serverVersion = "";

/** Keeping the key for a reload takes a few milliseconds (IndexedDB, WebCrypto); sign-in and unlock wait for it, so a
 *  reload right after them finds it, but never longer than this (a slow or broken IndexedDB only costs the password
 *  on the next reload). */
const KEEP_WAIT = 1500;
const kept = (userId: string, key: Uint8Array) => Promise.race([keepKey(userId, key), new Promise<void>((r) => setTimeout(r, KEEP_WAIT))]);

async function adopt(me: Me, masterKey: Uint8Array | null): Promise<void> {
  if (me.server_version) serverVersion = me.server_version; // the sign-in screen after a sign-out shows it too
  setCsrf(me.csrf);
  mem.me = me;
  mem.masterKey = masterKey;
  if (masterKey) await kept(me.user.id, masterKey); // for a reload of this tab (keep.ts)
}

/** A sign-in: the cookie is new, so the other tabs of this browser let go of the session they had (tabs.ts). */
async function signedIn(me: Me, masterKey: Uint8Array): Promise<void> {
  announce({ t: "signed-in", user: me.user.id, session: me.session_id });
  await adopt(me, masterKey);
}

/** The session the server answered for is not the one this tab holds: another account (or sign-in) took the cookie. */
const replaced = () => window.dispatchEvent(new Event("cf-session-replaced"));

/** A kept key is used only if it opens what the server keeps sealed under the account's master key. */
async function opensAccount(me: Me, key: Uint8Array): Promise<boolean> {
  const s = await getSodium();
  try { s.memzero(open(s, s.from_base64(me.wrapped_privkey, s.base64_variants.URLSAFE_NO_PADDING), key, LABEL.privkey, normEmail(me.user.email))); return true; } catch { return false; }
}

export async function loadSession(): Promise<Me | null> {
  try {
    const me = await api<Me>("GET", "/api/me");
    if (mem.me && !sameSession(mem.me, me.user.id, me.session_id)) { replaced(); return null; }
    // keep keys already in memory (e.g. after a back-button route), but only for the same account; after a reload
    // the key this tab kept (keep.ts), if it is this account's
    let key = mem.me && mem.me.user.id === me.user.id ? mem.masterKey : null;
    if (!key) { const k = await keptKey(me.user.id); if (k && (await opensAccount(me, k))) key = k; }
    await adopt(me, key);
    return me;
  } catch {
    return null;
  }
}

/** A public demo login this server offers on its sign-in page (DEMO_LOGIN), or null. */
export let demoLogin: { email: string; password: string } | null = null;

export async function needsSetup(): Promise<boolean> {
  const r = await api<{ needs_setup: boolean; server_version?: string; demo_login?: { email: string; password: string } }>("GET", "/api/setup/status");
  serverVersion = r.server_version ?? "";
  demoLogin = r.demo_login ?? null;
  return r.needs_setup;
}

/** A new recovery key to show. A replaced key (rotation, recovery) is stored only in commit(), after the person has
 *  saved the words: if commit's response is lost, nobody is left with a key that works but was never seen. A new
 *  account's key is stored with the account itself (storedKey: commit does nothing); closing the tab before saving it
 *  leaves a key never seen, which a new one under Account replaces. */
export interface PendingKey { words: string[]; email: string; commit: () => Promise<void> }

/** Runs send; if it fails, the request may still have gone through with only the response lost. verify checks that
 *  (by signing in with the new password), so a retry never fails on "already done" and a stored key is never lost. */
async function sendChecked(send: () => Promise<void>, verify?: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (e) {
    if (verify && (await verify().then(() => true, () => false))) return;
    throw e;
  }
}

function pendingKey(words: string[], email: string, send: () => Promise<void>, verify?: () => Promise<void>): PendingKey {
  return { words, email, commit: () => sendChecked(send, verify) };
}

/** A key already stored: only the words are left to show. */
const storedKey = (words: string[], email: string): PendingKey => ({ words, email, commit: async () => {} });

/** The keys of the last account this tab tried to create. A retry of the same form sends the same keys again, so if
 *  an earlier attempt went through unseen, the words shown are the ones the server has. */
let lastAccount: { form: string; acc: NewAccount } | null = null;

async function accountFor(form: string, email: string, password: string): Promise<NewAccount> {
  const s = await getSodium();
  const id = s.to_hex(s.crypto_generichash(32, `${form}\0${normEmail(email)}\0${password}`, null));
  if (lastAccount?.form !== id) lastAccount = { form: id, acc: await createAccount(s, email, password) };
  return lastAccount.acc;
}

/** Creates the account with send; if the response is lost, signing in shows whether it exists. It must also hold this
 *  attempt's master key: otherwise another attempt made it, with a recovery key this one never saw. */
async function createChecked(acc: NewAccount, email: string, password: string, send: () => Promise<void>): Promise<PendingKey> {
  try {
    await send();
  } catch (e) {
    let step: CodeStep | null;
    try {
      step = await login(email, password);
    } catch {
      throw e;
    }
    // a new account has no two-step sign-in: one that asks for a code was there before
    if (step) {
      step.cancel();
      throw new Error("This account already exists. Sign in with your password, then make a new recovery key under Account.");
    }
    const s = await getSodium();
    if (!mem.masterKey || s.memcmp(mem.masterKey, acc.masterKey) !== true) {
      await logout();
      throw new Error("This account already exists. Sign in with your password, then make a new recovery key under Account.");
    }
  }
  lastAccount = null;
  return storedKey(acc.recoveryWords, normEmail(email));
}

export async function setup(token: string, email: string, password: string): Promise<PendingKey> {
  const acc = await accountFor(`setup\0${token.trim()}`, email, password);
  // stored first, so a wrong token shows in the form; a lost response still ends with the words on screen
  return createChecked(acc, email, password, async () => {
    const me = await api<Me>("POST", "/api/setup", { setup_token: token.trim(), email: normEmail(email), ...acc.bundle });
    await signedIn(me, acc.masterKey);
  });
}

export async function inviteEmail(token: string): Promise<string> {
  return (await api<{ email: string }>("GET", `/api/invites/${encodeURIComponent(token)}`)).email;
}

export async function acceptInvite(token: string, email: string, password: string): Promise<PendingKey> {
  const acc = await accountFor(`invite\0${token}`, email, password);
  return createChecked(acc, email, password, async () => {
    const me = await api<Me>("POST", `/api/invites/${encodeURIComponent(token)}/accept`, acc.bundle);
    await signedIn(me, acc.masterKey);
  });
}

/** The second step of a sign-in to an account with two-step sign-in: the password was right, and the server wants a
 *  code from the authenticator app (or a recovery code) before it hands out a session or any of the account's keys.
 *  It holds the key derived from the password until the code is accepted or the person starts over. */
export interface CodeStep {
  /** Sends the code and signs in when it is right. A wrong code throws and the step stays; CodeExpired means the
   *  password is needed again (too old, too many wrong codes, the password changed). */
  finish(code: string): Promise<void>;
  /** Starting over: the key derived from the password is overwritten. */
  cancel(): void;
}

export class CodeExpired extends Error {}

/** The pending token of a password step that needs a code, or "" (any other failure). */
export function pendingToken(e: unknown): string {
  return e instanceof ApiError && e.status === 401 && e.code === "two_factor_required" && typeof e.body?.pending === "string" ? e.body.pending : "";
}

/** What went wrong with a code: "wrong" (try again), "expired" (back to the password) or "other". */
export function codeProblem(e: unknown): "wrong" | "expired" | "other" {
  if (!(e instanceof ApiError) || e.status !== 401) return "other";
  return e.code === "wrong_code" ? "wrong" : e.code === "two_factor_expired" ? "expired" : "other";
}

const EXPIRED = "This sign-in expired. Enter your password again.";

function codeStep(s: Awaited<ReturnType<typeof getSodium>>, email: string, kek: Uint8Array, pending: string): CodeStep {
  let open = true;
  const cancel = () => { if (open) { open = false; s.memzero(kek); } };
  return {
    cancel,
    async finish(code: string) {
      if (!open) throw new CodeExpired(EXPIRED);
      let me: Me;
      try {
        me = await api<Me>("POST", "/api/auth/login/2fa", { pending, code: code.trim() });
      } catch (e) {
        if (codeProblem(e) === "expired") { cancel(); throw new CodeExpired(EXPIRED); }
        if (codeProblem(e) === "wrong") throw new Error("That code isn't right. Check the time on your phone and try the newest code.");
        throw e;
      }
      open = false;
      try { await signedIn(me, unlockMasterKey(s, email, kek, me.wrapped_master_pw)); } finally { s.memzero(kek); }
    },
  };
}

/** Signs in. Returns a code step when the account has two-step sign-in (null when signed in already). */
export async function login(email: string, password: string): Promise<CodeStep | null> {
  const s = await getSodium();
  const e = normEmail(email);
  const kdf = await api<KdfParams>("GET", `/api/auth/params?email=${encodeURIComponent(e)}`);
  assertSaneKdf(kdf);
  clearPlayer(); // a different account may sign in on this browser: drop anything the Service Worker still holds
  const { auth, kek } = await loginProof(s, password, kdf);
  let me: Me;
  try {
    me = await api<Me>("POST", "/api/auth/login", { email: e, auth });
  } catch (err) {
    const pending = pendingToken(err);
    if (!pending) { s.memzero(kek); throw err; }
    return codeStep(s, e, kek, pending);
  }
  try { await signedIn(me, unlockMasterKey(s, e, kek, me.wrapped_master_pw)); } finally { s.memzero(kek); }
  return null;
}

/** The sign-in proof of the signed-in account's password, checked here first (a typo shows before anything is sent):
 *  what changing two-step sign-in sends to the server. */
export async function passwordProof(password: string): Promise<string> {
  const s = await getSodium();
  const me = mem.me!;
  assertSaneKdf(me.kdf);
  const { auth, kek } = await loginProof(s, password, me.kdf);
  try {
    s.memzero(unlockMasterKey(s, me.user.email, kek, me.wrapped_master_pw));
  } catch {
    throw new Error("That password isn't right.");
  } finally {
    s.memzero(kek);
  }
  return auth;
}

/** Session cookie is still valid after a reload; only the password is needed to rebuild the keys. */
export async function unlock(password: string): Promise<void> {
  const s = await getSodium();
  const me = mem.me!;
  assertSaneKdf(me.kdf);
  const { kek } = await loginProof(s, password, me.kdf);
  try {
    mem.masterKey = unlockMasterKey(s, me.user.email, kek, me.wrapped_master_pw);
  } catch {
    throw new Error("That password isn't right.");
  }
  await kept(me.user.id, mem.masterKey);
}

/** Sign-out never waits for the network: everything this tab holds is forgotten before this returns. The server is
 *  told in the background (the promise), with a deadline; keepalive lets the request finish if the tab goes away. */
export function logout(): Promise<void> {
  // sent first: forgetLocal drops the CSRF token it needs
  const told = api("POST", "/api/auth/logout", undefined, { timeout: 10_000, keepalive: true }).then(() => {});
  if (mem.me) announce({ t: "signed-out", user: mem.me.user.id, session: mem.me.session_id });
  forgetLocal();
  return told;
}

/** Everything this browser keeps for the account: at sign-out, and when another device signed this one out. The keys
 *  and decrypted data go at once; deleting what is stored (Cache Storage, IndexedDB) runs on in the background. */
export function forgetLocal(): void {
  dropRequests(); // answers still on their way belong to the keys going now
  void forgetKeptForGood();
  dropMasterKey();
  leaveSession();
  forgetDecrypted();
  clearCaches();
  clearPeople(true);
  clearPlayer();
  clearUploadMemory();
}

/** This tab no longer holds a session (what it stores is dropped by the caller). */
export function leaveSession(): void {
  mem.me = null;
  setCsrf("");
}

/** Before a reconnect (live.ts): the server still knows this tab's session, as the same account and session. A
 *  session that ended or was replaced takes the tab back to the sign-in screen. */
export async function checkSession(): Promise<void> {
  let me: Me;
  try {
    me = await api<Me>("GET", "/api/me");
  } catch (e) {
    // api.ts leaves a 401 for /api/me to the caller (sign-in screens ask it too)
    if (e instanceof ApiError && e.status === 401 && mem.me) window.dispatchEvent(new Event("cf-session-ended"));
    throw e;
  }
  if (!sameSession(mem.me, me.user.id, me.session_id)) { replaced(); throw new Error("Signed in elsewhere."); }
}

export async function changePassword(current: string, next: string): Promise<void> {
  const s = await getSodium();
  const me = mem.me!;
  if (!mem.masterKey) throw new Error("Unlock your library first.");
  assertSaneKdf(me.kdf);
  const { auth } = await loginProof(s, current, me.kdf);
  const ch = await rewrapForPassword(s, me.user.email, mem.masterKey, next);
  try {
    await api("POST", "/api/auth/password", { current_auth: auth, ...ch });
  } catch (e) {
    // the change may have gone through with only the response lost: pick up what the server now has, so the next
    // attempt (or an unlock) uses the current password settings instead of the old ones
    await api<Me>("GET", "/api/me").then((fresh) => { mem.me = { ...me, kdf: fresh.kdf, wrapped_master_pw: fresh.wrapped_master_pw }; }, () => {});
    throw e;
  }
  mem.me = { ...me, kdf: ch.new_kdf, wrapped_master_pw: ch.new_wrapped_master_pw };
}

/** Deletes the account permanently, after checking the password here first (a typo shows before anything is sent), then
 *  forgets everything this browser keeps. The server refuses for the only administrator. */
export async function deleteAccount(password: string): Promise<void> {
  const s = await getSodium();
  const me = mem.me!;
  assertSaneKdf(me.kdf);
  const { auth, kek } = await loginProof(s, password, me.kdf);
  try {
    s.memzero(unlockMasterKey(s, me.user.email, kek, me.wrapped_master_pw));
  } catch {
    throw new Error("That password isn't right.");
  }
  await api("DELETE", "/api/me", { current_auth: auth });
  announce({ t: "signed-out", user: me.user.id }); // every session of the account
  forgetLocal();
}

export interface RecoveryHandle {
  email: string;
  ticket: string;
  masterKey: Uint8Array;
}

export async function recoverStart(email: string, words: string): Promise<RecoveryHandle> {
  const s = await getSodium();
  const e = normEmail(email);
  const p = await recoveryProof(s, words);
  const r = await api<{ ticket: string; wrapped_master_recovery: string }>("POST", "/api/auth/recover/start", { email: e, recovery_auth: p.recovery_auth });
  let masterKey: Uint8Array;
  try {
    masterKey = unlockWithRecovery(s, e, p.recWrap, r.wrapped_master_recovery);
  } catch {
    throw new Error("This recovery key doesn't unlock the account.");
  } finally {
    s.memzero(p.recWrap);
  }
  return { email: e, ticket: r.ticket, masterKey };
}

export async function recoverFinish(h: RecoveryHandle, newPassword: string): Promise<PendingKey> {
  const s = await getSodium();
  const fin = await finishRecovery(s, h.email, h.masterKey, newPassword);
  // the ticket is single-use, so a retry can only check: the new recovery key must open the account (the new password
  // alone could match an earlier one)
  return pendingKey(fin.recoveryWords, h.email, async () => { await api("POST", "/api/auth/recover/finish", { ticket: h.ticket, ...fin.body }); },
    async () => { await recoverStart(h.email, fin.recoveryWords.join(" ")); });
}

/** Makes a new recovery key; the old one stops working once commit() stores the new one. Needs the current password
 *  and an unlocked library. Sending the same key again is harmless, so a retry needs no check. */
export async function rotateRecoveryKey(currentPassword: string): Promise<PendingKey> {
  const s = await getSodium();
  const me = mem.me!;
  if (!mem.masterKey) throw new Error("Unlock your library first.");
  assertSaneKdf(me.kdf);
  const { auth, kek } = await loginProof(s, currentPassword, me.kdf);
  try {
    unlockMasterKey(s, me.user.email, kek, me.wrapped_master_pw); // a typo shows here, not after the words
  } catch {
    throw new Error("That password isn't right.");
  }
  const kit = await newRecoveryKit(s, me.user.email, mem.masterKey);
  return pendingKey(kit.words, me.user.email, async () => {
    await api("POST", "/api/auth/recovery-key", { current_auth: auth, wrapped_master_recovery: kit.wrapped_master_recovery, recovery_verifier: kit.recovery_verifier });
  });
}

export const loadUsage = () => api<{ used_bytes: number; quota_bytes: number; unlimited: boolean }>("GET", "/api/me/usage");
