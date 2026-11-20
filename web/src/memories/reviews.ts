// The custom reviews of the account (custom.ts): one document encrypted with the master key, stored on the server as
// the "reviews" document and shared by all the person's devices. The server never learns what a review searches for,
// what it's called or what it showed. A server from before custom reviews doesn't know the document: then nothing can
// be saved and the menu says so.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { getSodium, b64, unb64 } from "../crypto/sodium";
import { decryptReviews, encryptReviews } from "../crypto/search";
import { mem } from "../state";
import { deleteReview, emptyDoc, periodOf, readDoc, recordShown, tidy, upsertReview, type Review, type ReviewDoc } from "./custom";

export const OLD_SERVER = "Your server needs an update for custom reviews.";

let doc: ReviewDoc = emptyDoc();
let version = 0;
/** the master key the document was opened with: another one (signed out, another account) starts afresh */
let owner: Uint8Array | null = null;
let loading: Promise<ReviewDoc> | null = null;
let failed = "";
const subs = new Set<() => void>();
const bump = () => subs.forEach((f) => f());

const need = () => {
  if (!mem.me || !mem.masterKey) throw new Error("Unlock your library first.");
  return { me: mem.me, masterKey: mem.masterKey };
};

async function fetchDoc(): Promise<ReviewDoc> {
  const { me, masterKey } = need();
  const s = await getSodium();
  try {
    const r = await api<{ data_enc: string; version: number }>("GET", "/api/me/blobs/reviews");
    if (mem.masterKey !== masterKey) return doc;
    doc = readDoc(decryptReviews(s, unb64(s, r.data_enc), masterKey, me.user.id));
    version = r.version;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
    doc = emptyDoc(); version = 0;
  }
  owner = masterKey;
  failed = "";
  bump();
  return doc;
}

/** Loads the document (again: another device changed it). */
export function loadReviews(): Promise<ReviewDoc> {
  loading ??= fetchDoc().catch((e) => { failed = e instanceof Error ? e.message : "Couldn't load your reviews."; bump(); throw e; })
    .finally(() => { loading = null; });
  return loading;
}

/** Applies a change and saves it; when another device saved in between, the change is applied to theirs. */
async function change(f: (d: ReviewDoc) => ReviewDoc): Promise<ReviewDoc> {
  const { me, masterKey } = need();
  const s = await getSodium();
  for (let i = 0; i < 4; i++) {
    if (owner !== masterKey || i > 0) await fetchDoc();
    const next = tidy(f(doc), Date.now());
    try {
      const r = await api<{ version: number }>("PUT", "/api/me/blobs/reviews", { data_enc: b64(s, encryptReviews(s, next, masterKey, me.user.id)), version });
      doc = next; version = r.version; bump();
      return doc;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new Error(OLD_SERVER);
      if (!(e instanceof ApiError && e.status === 409)) throw e;
    }
  }
  throw new Error("Couldn't save. Try again.");
}

const newId = async () => { const s = await getSodium(); return s.to_hex(s.randombytes_buf(8)); };

/** A new review, not saved yet. */
export const draft = (): Review => ({ id: "", name: "", query: "", every: "week", count: 12, notify: false, created: 0, updated: 0 });

export async function saveReview(r: Review): Promise<Review> {
  const id = r.id || await newId();
  const d = await change((d) => upsertReview(d, { ...r, id }, Date.now()));
  const saved = d.reviews.find((x) => x.id === id);
  if (!saved) throw new Error("This review was deleted on another device.");
  return saved;
}

/** Forgets the decrypted reviews (lock, sign-out). */
export function clearReviews() {
  doc = emptyDoc(); version = 0; owner = null; failed = "";
  bump();
}

export const removeReview = (id: string) => change((d) => deleteReview(d, id, Date.now()));

/** Remembers that a review was watched now with these photos (once a period; again in the same period changes nothing). */
export async function watched(r: Review, ids: string[], now = new Date()): Promise<void> {
  const period = periodOf(r.every, now);
  const s = doc.shown[r.id];
  if (s && s.period === period) return;
  // watched on another device in this period meanwhile: its story stays the period's
  await change((d) => (d.reviews.some((x) => x.id === r.id) && d.shown[r.id]?.period !== period ? recordShown(d, r.id, period, ids) : d));
}

/** The document, loaded the first time it's asked for; null until then. */
export function useReviews(): { doc: ReviewDoc | null; error: string } {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((x) => x + 1);
    subs.add(f);
    if (owner !== mem.masterKey && !loading) loadReviews().catch(() => {});
    return () => { subs.delete(f); };
  }, []);
  return { doc: owner && owner === mem.masterKey ? doc : null, error: failed };
}

/** Opens the menu from anywhere (Account › Memories): the library shows it. */
export const openReviewsMenu = () => window.dispatchEvent(new Event("cf-reviews-menu"));
