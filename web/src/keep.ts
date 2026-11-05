// Staying unlocked across a reload of the tab. The master key lives in memory; a reload would lose it and ask for the
// password again although the session is still valid. So at unlock it is encrypted with a random AES key that the
// browser creates as non-extractable (WebCrypto) and keeps in IndexedDB, and the ciphertext goes into sessionStorage,
// which belongs to this tab: a reload finds it, a closed tab or a new one doesn't. The AES key can't be read out of
// the browser, only used by this origin. Lock, sign-out and being signed out from another device delete both.
const DB = "cf-keep", STORE = "k", SLOT = "cf.mk";

function db(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((ok, bad) => {
      const q = f(d.transaction(STORE, mode).objectStore(STORE));
      q.onsuccess = () => ok(q.result as T);
      q.onerror = () => bad(q.error);
    });
  } finally {
    d.close();
  }
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Remembers the master key for reloads of this tab (best effort: without IndexedDB the password is asked again). */
export async function keepKey(userId: string, master: Uint8Array): Promise<void> {
  try {
    let k = await idb<CryptoKey | undefined>("readonly", (s) => s.get(userId));
    if (!k) {
      k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await idb("readwrite", (s) => s.put(k, userId));
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) }, k, new Uint8Array(master)));
    sessionStorage.setItem(SLOT, JSON.stringify({ u: userId, iv: b64(iv), ct: b64(ct) }));
  } catch { /* not kept: a reload asks for the password */ }
}

/** The master key kept by this tab before a reload, or null. The caller checks it opens the account's keys. */
export async function keptKey(userId: string): Promise<Uint8Array | null> {
  try {
    const raw = sessionStorage.getItem(SLOT);
    if (!raw) return null;
    const v = JSON.parse(raw) as { u: string; iv: string; ct: string };
    if (v.u !== userId) { forgetKept(); return null; }
    const k = await idb<CryptoKey | undefined>("readonly", (s) => s.get(userId));
    if (!k) return null;
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(v.iv), additionalData: new TextEncoder().encode(userId) }, k, unb64(v.ct)));
  } catch {
    forgetKept();
    return null;
  }
}

/** Lock: this tab forgets the kept key (the password is needed again). */
export function forgetKept(): void {
  try { sessionStorage.removeItem(SLOT); } catch { /* nothing kept */ }
}

/** Sign-out: also the browser's AES key for every account, so nothing kept earlier can be opened again. */
export async function forgetKeptForGood(): Promise<void> {
  forgetKept();
  try { await idb("readwrite", (s) => s.clear()); } catch { /* nothing kept */ }
}
