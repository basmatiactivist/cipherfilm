import { api, setCsrf } from "./api";
import { getSodium } from "./crypto/sodium";
import {
  createAccount, finishRecovery, type NewAccount, newRecoveryKit, loginProof, normEmail, recoveryProof, rewrapForPassword,
  unlockMasterKey, unlockWithRecovery,
} from "./crypto/account";
import type { KdfParams } from "./crypto/kdf";
import { mem, Me } from "./state";
import { clearCaches } from "./cache";
import { clearPeople } from "./people/people";
import { clearPlayer } from "./player";
import { clearUploadMemory, forgetDecrypted } from "./items";
import { forgetKeptForGood, keepKey, keptKey } from "./keep";
import { open, LABEL } from "./crypto/wrap";

/** Give the browser a frame to paint a busy state before Argon2 blocks the thread. */
export const paint = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** A server could hand out weak or absurd KDF settings; refuse anything outside the range the server itself enforces. */
function assertSaneKdf(k: KdfParams) {
  if (!(k.ops >= 2 && k.ops <= 10 && k.mem >= 32 * 1024 * 1024 && k.mem <= 1024 * 1024 * 1024)) {
    throw new Error("The server sent unexpected password-hashing settings. Sign-in was stopped for your safety.");
  }
}

function adopt(me: Me, masterKey: Uint8Array | null) {
  setCsrf(me.csrf);
  mem.me = me;
  mem.masterKey = masterKey;
  if (masterKey) void keepKey(me.user.id, masterKey); // for a reload of this tab (keep.ts)
}

/** A kept key is used only if it opens what the server keeps sealed under the account's master key. */
async function opensAccount(me: Me, key: Uint8Array): Promise<boolean> {
  const s = await getSodium();
  try { s.memzero(open(s, s.from_base64(me.wrapped_privkey, s.base64_variants.URLSAFE_NO_PADDING), key, LABEL.privkey, normEmail(me.user.email))); return true; } catch { return false; }
}

export async function loadSession(): Promise<Me | null> {
  try {
    const me = await api<Me>("GET", "/api/me");
    // keep keys already in memory (e.g. after a back-button route), but only for the same account; after a reload
    // the key this tab kept (keep.ts), if it is this account's
    let key = mem.me && mem.me.user.id === me.user.id ? mem.masterKey : null;
    if (!key) { const k = await keptKey(me.user.id); if (k && (await opensAccount(me, k))) key = k; }
    adopt(me, key);
    return me;
  } catch {
    return null;
  }
}

export const needsSetup = async (): Promise<boolean> => (await api<{ needs_setup: boolean }>("GET", "/api/setup/status")).needs_setup;

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
    try {
      await login(email, password);
    } catch {
      throw e;
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
    adopt(me, acc.masterKey);
  });
}

export async function inviteEmail(token: string): Promise<string> {
  return (await api<{ email: string }>("GET", `/api/invites/${encodeURIComponent(token)}`)).email;
}

export async function acceptInvite(token: string, email: string, password: string): Promise<PendingKey> {
  const acc = await accountFor(`invite\0${token}`, email, password);
  return createChecked(acc, email, password, async () => {
    const me = await api<Me>("POST", `/api/invites/${encodeURIComponent(token)}/accept`, acc.bundle);
    adopt(me, acc.masterKey);
  });
}

export async function login(email: string, password: string): Promise<void> {
  const s = await getSodium();
  const e = normEmail(email);
  const kdf = await api<KdfParams>("GET", `/api/auth/params?email=${encodeURIComponent(e)}`);
  assertSaneKdf(kdf);
  clearPlayer(); // a different account may sign in on this browser: drop anything the Service Worker still holds
  const { auth, kek } = await loginProof(s, password, kdf);
  const me = await api<Me>("POST", "/api/auth/login", { email: e, auth });
  adopt(me, unlockMasterKey(s, e, kek, me.wrapped_master_pw));
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
  void keepKey(me.user.id, mem.masterKey);
}

export async function logout(): Promise<void> {
  try {
    await api("POST", "/api/auth/logout");
  } finally {
    forgetLocal();
  }
}

/** Everything this browser keeps for the account: at sign-out, and when another device signed this one out. */
export function forgetLocal(): void {
  void forgetKeptForGood();
  mem.masterKey = null;
  mem.me = null;
  setCsrf("");
  forgetDecrypted();
  clearCaches();
  clearPeople(true);
  clearPlayer();
  clearUploadMemory();
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
