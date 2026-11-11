// People on the web: the faces the Android and Mac apps found (the search index, docs/SEARCH.md), grouped here the
// same way they group them (faces.ts, in a worker), and what the person decided about them (names, "this is also
// Anna", "not Anna") in one document encrypted with the master key, shared by all their devices. The web never looks
// at a photo to find faces; without index entries there are no people here.
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { getSodium, b64, unb64 } from "../crypto/sodium";
import { accountKeyPair } from "../crypto/item";
import { normEmail } from "../crypto/account";
import { decryptPeople, encryptPeople, openIndexEntry } from "../crypto/search";
import { mem } from "../state";
import { FaceIndex, type Cover, type FaceFound, type FaceGroup } from "./faces";
import type { Req } from "./faces.worker";
import { clearContent, putVectors } from "../search/content";
import { unfiltered } from "../search/rank";

export interface Person { id: string; name: string; hidden?: boolean; anchors: string[]; rejects: string[] }
/** explicit: the person chose explicit search, search results without the explicit-content filter (all devices, while
 *  an admin allows it; docs/SEARCH.md "Explicit content") */
interface Doc { v: 1; people: Person[]; explicit?: boolean }

/** A group of faces on screen: a named person, or someone not named yet. */
export interface Group { key: string; person?: Person; items: string[]; faces: string[]; cover?: Cover }

const THRESHOLD = 0.5; // SFace cosine: same person usually above 0.6, different people below 0.3
export const MIN_FACES = 3;
const MAX_ANCHORS = 60;

const need = () => {
  if (!mem.me || !mem.masterKey) throw new Error("Unlock your library first.");
  return { me: mem.me, masterKey: mem.masterKey };
};

// ---- grouping, in a worker (or here, where there are no workers) ----

let worker: Worker | null = null;
let local: FaceIndex | null = null;
const waiting = new Map<number, { ok: (g: FaceGroup[]) => void; fail: (e: Error) => void }>();
let nextId = 1;

function send(r: Req) {
  if (typeof Worker === "undefined") {
    local ??= new FaceIndex();
    if (r.t === "put") for (const x of r.entries) local.put(x.item, x.faces);
    else if (r.t === "remove") for (const x of r.items) local.remove(x);
    else if (r.t === "clear") local.clear();
    return;
  }
  if (!worker) {
    worker = new Worker(new URL("./faces.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      e.data.ok ? w?.ok(e.data.groups) : w?.fail(new Error(e.data.error));
    };
    worker.onerror = () => { for (const w of waiting.values()) w.fail(new Error("Couldn't group faces.")); waiting.clear(); };
  }
  worker.postMessage(r);
}

function cluster(anchors: [string, string[]][], rejects: Record<string, string[]>): Promise<FaceGroup[]> {
  if (typeof Worker === "undefined") return Promise.resolve((local ??= new FaceIndex()).cluster(THRESHOLD, anchors, rejects, 1));
  const id = nextId++;
  return new Promise((ok, fail) => { waiting.set(id, { ok, fail }); send({ t: "cluster", id, threshold: THRESHOLD, anchors, rejects, minFaces: 1 }); });
}

// ---- the index: fetched page by page, opened with the account's private key, faces only ----

let since = 0;
let entries = 0;
let fetchedAt = 0;
let fetching: Promise<void> | null = null;
const facesByItem = new Map<string, { key: string; box: number[] }[]>();

interface Page { entries: { item_id: string; data_enc: string; updated_at: number }[]; next: string }

async function fetchIndex(): Promise<void> {
  const { me, masterKey } = need();
  const s = await getSodium();
  let pair: ReturnType<typeof accountKeyPair> | undefined;
  try {
    for (let after = ""; ;) {
      const page = await api<Page>("GET", `/api/index?${after ? `after=${encodeURIComponent(after)}` : `since=${since}`}`);
      if (mem.masterKey !== masterKey) return; // locked or signed out meanwhile
      pair ??= accountKeyPair(s, unb64(s, me.wrapped_privkey), masterKey, normEmail(me.user.email));
      const put: { item: string; faces: FaceFound[] }[] = [];
      const vecs: { item: string; m?: string; clip?: Uint8Array }[] = [];
      for (const e of page.entries) {
        since = Math.max(since, e.updated_at);
        let faces: FaceFound[] = [];
        try {
          const entry = openIndexEntry(s, unb64(s, e.data_enc), pair, e.item_id);
          let clip: Uint8Array | undefined;
          try { clip = entry.clip ? unb64(s, entry.clip) : undefined; } catch { /* unreadable vector: not searchable */ }
          vecs.push({ item: e.item_id, m: entry.m, clip });
          // like the Mac: a face whose vector can't be read is left out before the faces are numbered
          faces = (entry.faces ?? []).flatMap((f) => { try { return [{ box: f.box, score: f.score, emb: unb64(s, f.emb) }]; } catch { return []; } });
        } catch { vecs.push({ item: e.item_id }); /* damaged or not for this item: the phone or Mac makes it again */ }
        if (!facesByItem.has(e.item_id)) entries++;
        const keys: { key: string; box: number[] }[] = [];
        faces.forEach((f, k) => { if (f.emb.length >= 256 && f.box.length === 4) keys.push({ key: `${e.item_id}:${k}`, box: f.box }); });
        facesByItem.set(e.item_id, keys);
        put.push({ item: e.item_id, faces });
      }
      send({ t: "put", entries: put });
      putVectors(vecs);
      if (put.length) bump();
      if (!page.next) break;
      after = page.next;
      await new Promise((r) => setTimeout(r, 0)); // let the page breathe between pages
    }
    fetchedAt = Date.now();
    bump();
  } finally {
    if (pair) s.memzero(pair.sk);
  }
}

/** Fetches what other devices indexed since the last time; at most once a minute unless forced. */
export function refreshIndex(force = false): Promise<void> {
  if (!force && fetchedAt && Date.now() - fetchedAt < 60_000) return Promise.resolve();
  fetching ??= fetchIndex().finally(() => { fetching = null; });
  return fetching;
}

/** True once the account has index entries: only then are people shown here. */
export const hasIndex = () => entries > 0;
export const indexChecked = () => fetchedAt > 0;

// ---- the people document ----

let doc: Doc = { v: 1, people: [] };
let version = 0;
let loaded = false;

export async function loadPeople(): Promise<Doc> {
  const { me, masterKey } = need();
  const s = await getSodium();
  try {
    const r = await api<{ data_enc: string; version: number }>("GET", "/api/me/blobs/people");
    if (mem.masterKey !== masterKey) return doc;
    doc = decryptPeople<Doc>(s, unb64(s, r.data_enc), masterKey, me.user.id);
    version = r.version;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
    doc = { v: 1, people: [] }; version = 0;
  }
  loaded = true;
  bump();
  return doc;
}

/** Applies a change and saves it; if another device saved in between, the change is applied to theirs. */
async function change(f: (d: Doc) => void) {
  const { me, masterKey } = need();
  const s = await getSodium();
  for (let i = 0; i < 4; i++) {
    if (!loaded || i > 0) await loadPeople();
    const next: Doc = JSON.parse(JSON.stringify(doc));
    f(next);
    try {
      const r = await api<{ version: number }>("PUT", "/api/me/blobs/people", { data_enc: b64(s, encryptPeople(s, next, masterKey, me.user.id)), version });
      doc = next; version = r.version; bump();
      return;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
    }
  }
  throw new Error("Couldn't save. Try again.");
}

const newId = async () => { const s = await getSodium(); return s.to_hex(s.randombytes_buf(8)); };
const take = (keys: string[]) => keys.slice(0, MAX_ANCHORS);
export const MAX_NAME = 80;
const sameName = (name: string) => doc.people.find((p) => p.name && p.name.toLowerCase() === name.toLowerCase());

/** Names a group (or renames a person). A name someone already has joins the group to them. Returns the person's id. */
export async function nameGroup(g: Group, name: string): Promise<string | undefined> {
  const clean = name.trim().slice(0, MAX_NAME);
  if (!clean) return;
  if (!loaded) await loadPeople();
  const same = sameName(clean);
  if (same && same.id !== g.person?.id) { await mergeInto(g, same); return same.id; }
  const id = g.person?.id ?? await newId();
  await change((d) => {
    const p = d.people.find((x) => x.id === id);
    if (p) { p.name = clean; p.hidden = false; }
    else d.people.push({ id, name: clean, anchors: take(g.faces), rejects: [] });
  });
  return id;
}

/** "These are the same person": the group's faces become the person's too. */
export async function mergeInto(g: Group, into: Person) {
  await change((d) => {
    const p = d.people.find((x) => x.id === into.id);
    if (!p) return;
    p.anchors = [...new Set([...p.anchors, ...take(g.faces)])].slice(-400);
    if (g.person && g.person.id !== into.id) d.people = d.people.filter((x) => x.id !== g.person!.id);
  });
}

// ---- groups ----

let ver = 0;
let groups: Group[] = [];
let allGroups: Group[] = [];
let groupsAt = -1;
let groupsFor: Set<string> | null = null;
let grouping: Promise<Group[]> | null = null;
const subs = new Set<() => void>();
function bump() { ver++; subs.forEach((f) => f()); }

/** Every group (also those under three photos, for a photo's details), worked out again when something changed. */
async function computeGroups(live: Set<string>): Promise<Group[]> {
  if (!loaded) await loadPeople().catch(() => {});
  const at = ver;
  if (groupsAt === at && groupsFor === live) return allGroups;
  const raw = await cluster(doc.people.map((p) => [p.id, p.anchors]), Object.fromEntries(doc.people.map((p) => [p.id, p.rejects])));
  const byId = new Map(doc.people.map((p) => [p.id, p]));
  const seen = new Set<string>();
  allGroups = raw.map((g, i): Group => {
    const person = g.person ? byId.get(g.person) : undefined;
    return { key: person?.id ?? `g${i}:${g.cover?.key}`, person, items: g.items.filter((x) => live.has(x)), faces: g.faces, cover: g.cover };
  }).filter((g) => g.items.length && (!g.person || !seen.has(g.person.id) && !!seen.add(g.person.id)));
  groups = allGroups.filter((g) => g.person ? !g.person.hidden : g.items.length >= MIN_FACES);
  groupsAt = at; groupsFor = live;
  return allGroups;
}

function allFor(live: Set<string>): Promise<Group[]> {
  if (groupsAt === ver && groupsFor === live) return Promise.resolve(allGroups);
  grouping ??= computeGroups(live).finally(() => { grouping = null; });
  return grouping.then((g) => (groupsAt === ver && groupsFor === live ? g : allFor(live)));
}

/** The people for the People page and the groups a photo's faces belong to, kept current. Null while loading.
 *  live: the ids of the items in the library (not in the trash), the same Set as long as the library is the same. */
export function usePeople(live: Set<string>): { groups: Group[] | null; all: Group[]; ready: boolean; error: string } {
  const [state, setState] = useState<{ groups: Group[] | null; all: Group[]; error: string }>({ groups: null, all: [], error: "" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((t) => t + 1);
    subs.add(f);
    refreshIndex().catch((e) => setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Couldn't load people." })));
    return () => { subs.delete(f); };
  }, []);
  useEffect(() => {
    let alive = true;
    refreshIndex().catch(() => {}); // the library changed: entries other devices made meanwhile (at most once a minute)
    if (!indexChecked() && !hasIndex()) return;
    allFor(live).then((all) => alive && setState({ groups: hasIndex() ? groups : [], all, error: "" }),
      (e) => alive && setState((s) => ({ ...s, groups: s.groups ?? [], error: e instanceof Error ? e.message : "Couldn't group faces." })));
    return () => { alive = false; };
  }, [tick, live]);
  return { ...state, ready: indexChecked() };
}

/** Every face found in a photo, with the person or group it belongs to (if any), for the photo's details. */
export interface FaceInPhoto { key: string; cover: Cover; group?: Group }
export function facesIn(itemId: string, all: Group[]): FaceInPhoto[] {
  return (facesByItem.get(itemId) ?? []).map((f) => ({ key: f.key, cover: { key: f.key, item: itemId, box: f.box }, group: all.find((g) => g.faces.includes(f.key)) }));
}

/** Names the person of one face: its group, someone who already has that name, or a new person of just this face. */
export async function nameFace(f: FaceInPhoto, name: string): Promise<string | undefined> {
  const clean = name.trim().slice(0, MAX_NAME);
  if (!clean) return;
  if (!loaded) await loadPeople();
  if (f.group) return nameGroup(f.group, clean);
  const id = sameName(clean)?.id ?? await newId();
  await change((d) => {
    const p = d.people.find((x) => x.id === id);
    if (p) { p.anchors = [...new Set([...p.anchors, f.key])].slice(-400); p.rejects = p.rejects.filter((k) => k !== f.key); }
    else d.people.push({ id, name: clean, anchors: [f.key], rejects: [] });
  });
  return id;
}

/** Names already given, for suggestions while typing. */
export const knownNames = () => doc.people.filter((p) => p.name && !p.hidden).map((p) => p.name).sort((a, b) => a.localeCompare(b));

// ---- face pictures: cropped from the decrypted thumbnail or preview, in memory only ----

const crops = new Map<string, string>();
const cropping = new Map<string, Promise<string | null>>();

/** A square around the face, half again as big, like the phone's: an object URL, revoked at sign-out. */
export function faceCrop(cover: Cover, imageUrl: string): Promise<string | null> {
  const hit = crops.get(cover.key);
  if (hit) return Promise.resolve(hit);
  let p = cropping.get(cover.key);
  if (!p) {
    const key = mem.masterKey;
    p = (async () => {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();
      const W = img.naturalWidth, H = img.naturalHeight, b = cover.box;
      const cx = (b[0] + b[2] / 2) * W, cy = (b[1] + b[3] / 2) * H;
      const side = Math.max(8, Math.max(b[2] * W, b[3] * H) * 1.5);
      const l = Math.min(Math.max(0, cx - side / 2), W - 1), t = Math.min(Math.max(0, cy - side / 2), H - 1);
      const sz = Math.max(1, Math.floor(Math.min(side, W - l, H - t)));
      const c = document.createElement("canvas");
      c.width = c.height = 160;
      c.getContext("2d")!.drawImage(img, l, t, sz, sz, 0, 0, 160, 160);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.85));
      if (!blob || mem.masterKey !== key) return null;
      const url = URL.createObjectURL(blob);
      crops.set(cover.key, url);
      if (crops.size > 300) { const [k, u] = crops.entries().next().value!; crops.delete(k); URL.revokeObjectURL(u); }
      return url;
    })().catch(() => null).finally(() => cropping.delete(cover.key));
    cropping.set(cover.key, p);
  }
  return p;
}

/** The person chose explicit search for the account (all its devices; docs/SEARCH.md "Explicit content"). */
export const explicitChosen = () => doc.explicit === true;
/** Whether search leaves out explicit photos and words: unless an admin allows explicit search and the person chose
 *  it. (Only what is shown changes: one model and one index for everyone.) */
export const searchFiltered = () => !unfiltered({ allowed: !!mem.me?.user.nsfw, chosen: doc.explicit === true });
export const peopleLoaded = () => loaded;

/** Explicit search on or off for the account: its devices show explicit photos in search, or leave them out. Nothing
 *  is indexed again or deleted. */
export async function setExplicit(on: boolean) {
  await change((d) => { if (on) d.explicit = true; else delete d.explicit; });
}

/** Forgets everything at sign-out, lock or when the session ends; at sign-out also the search model's file. */
export function clearPeople(signOut = false) {
  crops.forEach((u) => URL.revokeObjectURL(u)); crops.clear();
  send({ t: "clear" });
  clearContent(signOut);
  facesByItem.clear(); since = 0; entries = 0; fetchedAt = 0;
  doc = { v: 1, people: [] }; version = 0; loaded = false;
  groups = []; allGroups = []; groupsAt = -1; groupsFor = null; bump();
}
