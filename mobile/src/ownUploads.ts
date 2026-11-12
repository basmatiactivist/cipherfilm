// What this phone uploaded itself (the backup and the Upload button), per account: each item's id with a hash of the
// wrapped item key exactly as this phone sent it. Something that acts on an item because "it is this phone's file"
// (adding the location from the original, relocate.ts) checks it here first: the name and size in an item's metadata
// prove nothing, as anyone who can add items to the account (the server, or a stolen session using the public key)
// can write any name and size, under an item key of their own. The wrapped key the server hands out must also still
// be the one sent from here, so a key swapped in later under the same id doesn't count either.
// Item ids and hashes only, in the app's private files; deleted at sign-out.
import { Directory, File, Paths } from "expo-file-system";
import { getSodium, unb64 } from "@crypto/sodium";
import { onSignOut } from "./session";

const DIR = () => new Directory(Paths.document, "own-uploads");
const SAFE = /^[0-9A-Za-z_-]{1,64}$/;
const fileFor = (userId: string) => new File(DIR(), `${userId}.json`);

/** A short hash of the wrapped item key as base64 (what the server stores and hands out). */
export async function wrapPrint(wrappedB64: string): Promise<string> {
  const s = await getSodium();
  return s.to_hex(s.crypto_generichash(16, unb64(s, wrappedB64), null));
}

let chain: Promise<unknown> = Promise.resolve();

async function read(userId: string): Promise<Record<string, string>> {
  try {
    const f = fileFor(userId);
    if (!f.exists) return {};
    const d = JSON.parse(await f.text()) as { userId?: string; wraps?: Record<string, string> };
    return d.userId === userId && d.wraps && typeof d.wraps === "object" ? d.wraps : {};
  } catch { return {}; }
}

/** Notes an item this phone uploaded and finalized, with the wrapped key it sent. */
export function noteOwnUpload(userId: string, id: string, wrappedB64: string): Promise<void> {
  if (!SAFE.test(userId)) return Promise.resolve();
  const next = chain.then(async () => {
    const wraps = await read(userId);
    wraps[id] = await wrapPrint(wrappedB64);
    const dir = DIR();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    await fileFor(userId).write(JSON.stringify({ userId, wraps }));
  }).catch(() => { /* not noted: such an item is simply never treated as this phone's own */ });
  chain = next;
  return next;
}

/** The items this phone uploaded for the account: id → hash of the wrapped key it sent. */
export function ownUploads(userId: string): Promise<Map<string, string>> {
  if (!SAFE.test(userId)) return Promise.resolve(new Map());
  const next = chain.then(async () => new Map(Object.entries(await read(userId))));
  chain = next.catch(() => {});
  return next;
}

/** The items of `items` that are this phone's own uploads, with the very wrapped key this phone sent. */
export async function provablyOwn(userId: string, items: { id: string; wrapped?: string }[]): Promise<Set<string>> {
  const own = await ownUploads(userId);
  const out = new Set<string>();
  for (const it of items) {
    const want = own.get(it.id);
    if (!want || !it.wrapped) continue;
    try { if ((await wrapPrint(it.wrapped)) === want) out.add(it.id); } catch { /* not this phone's */ }
  }
  return out;
}

onSignOut(() => { try { const d = DIR(); if (d.exists) d.delete(); } catch { /* best effort */ } });
