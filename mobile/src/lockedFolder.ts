// The locked folder (docs/EDITING.md, "Archive and locked folder"): items whose encrypted metadata says `locked: true`.
// No key of its own: the same master key opens them, but the app shows them only here, behind a fresh check of the
// phone's fingerprint, face or screen lock (or the account password where the phone has none) every time the folder
// opens, even while the library is unlocked. Nowhere else: the library store splits them off right after decrypting
// (libraryStore.ts), so no other screen is ever handed one.
//
// Nothing of them on disk: their thumbnails never reach the native thumbnail pipeline or the encrypted cache folder
// (library.ts); this file decrypts them into memory, and everything (the list, the thumbnails, video keys) goes when
// the folder closes (its screen is left, or the app goes to the background) and at every lock and sign-out (onWipe).
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import N from "../modules/cf-native/src/CfNativeModule";
import { thumbBytes, type Item } from "./library";
import { lockedItems, onLockedChange, refreshLibrary } from "./libraryStore";
import { onWipe, passwordProof, session } from "./session";
import { away } from "./autolock";
import { api } from "./api";
import { t } from "./i18n";

let items: Item[] | null = null; // null: closed
let gen = 0; // bumped at every close: a thumbnail still decrypting then is dropped
const thumbs = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
let unfollow: (() => void) | null = null;

const subs = new Set<() => void>();
let snap: { open: boolean; items: Item[] | null } = { open: false, items: null };
const emit = () => { snap = { open: items !== null, items }; subs.forEach((f) => f()); };

export const useLockedFolder = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snap);
/** The locked items while the folder is open (the viewer, opened from it); empty otherwise. */
export const lockedFolderItems = (): Item[] => items ?? [];
export const lockedFolderOpen = () => items !== null;
/** Whether a screen opened from the folder (the viewer, within "locked") must leave now: the folder closed (the app
 *  went to the background, a lock), so its photos go off screen with it and the folder asks again. */
export const mustLeaveFolder = (within: string | undefined, open: boolean) => within === "locked" && !open;

// ---- the check ----

export type Check = "passed" | "failed" | "password";

/**
 * The phone's own check (fingerprint, face, or its PIN, pattern or password), asked fresh every time. "password":
 * the phone has none set up, so the account password is asked instead (passwordCheck). "failed": cancelled or wrong.
 */
export async function deviceCheck(): Promise<Check> {
  let level: LocalAuthentication.SecurityLevel;
  try { level = await LocalAuthentication.getEnrolledLevelAsync(); } catch { return "password"; }
  if (level === LocalAuthentication.SecurityLevel.NONE) return "password";
  // the system's prompt (and its PIN screen) may take the app off screen: that isn't leaving it (autolock.ts)
  const r = await away(() => LocalAuthentication.authenticateAsync({ promptMessage: t("Open the locked folder"), disableDeviceFallback: false }));
  if (r.success) return "passed";
  return r.error === "not_enrolled" || r.error === "passcode_not_set" || r.error === "not_available" ? "password" : "failed";
}

/** The account password, checked on this phone only (the key it wraps must open: session.ts), no server call. */
export async function passwordCheck(password: string): Promise<void> {
  await passwordProof(password); // throws "That password isn't right."
}

// ---- open and closed ----

/** After a check passed: the folder shows the locked items, and follows changes to them while it is open. */
export function openLockedFolder() {
  if (!session().masterKey) throw new Error(t("Unlock your library first."));
  items = lockedItems();
  unfollow?.();
  unfollow = onLockedChange(() => {
    if (items === null) return;
    const now = lockedItems();
    const ids = new Set(now.map((i) => i.id));
    for (const id of [...thumbs.keys()]) if (!ids.has(id)) thumbs.delete(id); // moved out or deleted
    items = now;
    emit();
  });
  emit();
  refreshLibrary({ quiet: true }).catch(() => {}); // what changed on other devices
}

/** Leaves the folder: the list, the decrypted thumbnails and the video keys leave memory. */
export function closeLockedFolder() {
  const was = items !== null || thumbs.size > 0;
  gen++;
  unfollow?.();
  unfollow = null;
  items = null;
  thumbs.clear();
  inflight.clear();
  if (was) try { N.forgetVideos?.(); } catch { /* an older native module: they go at the next lock */ }
  emit();
}

onWipe(() => closeLockedFolder());
// the app going to the background closes it too, also when it doesn't lock then: back in it, the folder asks again
// (the check's own screen-lock prompt may take the app to the background before the folder opens: nothing to close then)
AppState?.addEventListener?.("change", (s) => { if (s === "background") closeLockedFolder(); });

// ---- pictures ----

/** A locked item's thumbnail as a data: URI, decrypted into memory only (never the disk cache: library.ts); null when
 *  there is none, or the folder closed meanwhile. */
export function lockedThumbUri(it: Item): Promise<string | null> {
  const hit = thumbs.get(it.id);
  if (hit) return Promise.resolve(hit);
  if (items === null || !it.has_thumb || it.broken || !it.itemKey) return Promise.resolve(null);
  let p = inflight.get(it.id);
  if (!p) {
    const mine = gen;
    p = (async () => {
      const plain = await thumbBytes(it);
      try {
        if (mine !== gen || items === null || !session().masterKey) return null;
        const uri = "data:image/jpeg;base64," + N.base64(plain);
        thumbs.set(it.id, uri);
        return uri;
      } finally { plain.fill(0); }
    })().catch(() => null).finally(() => { if (mine === gen) inflight.delete(it.id); });
    inflight.set(it.id, p);
  }
  return p;
}

// ---- deleting ----

/** Deletes locked items permanently: to the trash, then out of it at once (the trash screen never shows them). */
export async function deleteForever(ids: string[]) {
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    await api("POST", "/api/items/trash", { item_ids: part });
    await api("POST", "/api/trash/purge", { item_ids: part });
  }
  for (const id of ids) thumbs.delete(id);
}
