// People: faces grouped on the phone (SearchIndex.cluster), and what the person decided about them (names, "this is
// also Anna", "not Anna", hidden) in one document encrypted with the master key, shared by their devices.
import { useEffect, useState } from "react";
import { getSodium, b64, unb64 } from "@crypto/sodium";
import { decryptPeople, encryptPeople } from "@crypto/search";
import N, { type FaceGroup } from "../../modules/cf-native/src/CfNativeModule";
import { api, ApiError } from "../api";
import { onWipe, session } from "../session";
import { libraryItems } from "../libraryStore";
import { thumbBytes } from "../library";
import { indexVersion, searchReady } from "./engine";
import { loadSettings } from "./settings";

export interface Person { id: string; name: string; hidden?: boolean; anchors: string[]; rejects: string[] }
interface Doc { v: 1; people: Person[]; /** explicit search chosen (docs/SEARCH.md): used only if an admin allows it */ explicit?: boolean }

/** A group of faces on screen: a named person, or someone not named yet. */
export interface Group { key: string; person?: Person; items: string[]; faces: string[]; cover: FaceGroup["cover"] }

const THRESHOLD = 0.5; // SFace cosine: same person usually above 0.6, different people below 0.3
const MIN_FACES = 3;
const MAX_ANCHORS = 60;

let doc: Doc = { v: 1, people: [] };
let version = 0;
let loaded = false;

const need = () => {
  const { me, masterKey } = session();
  if (!me || !masterKey) throw new Error("Unlock your library first.");
  return { me, masterKey };
};

export async function loadPeople(): Promise<Doc> {
  const { me, masterKey } = need();
  const s = await getSodium();
  try {
    const r = await api<{ data_enc: string; version: number }>("GET", "/api/me/blobs/people");
    doc = decryptPeople<Doc>(s, unb64(s, r.data_enc), masterKey, me.user.id);
    version = r.version;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
    doc = { v: 1, people: [] }; version = 0;
  }
  loaded = true;
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

/** Names a group (or renames a person); returns the person's id, the group's key from now on. */
export async function nameGroup(g: Group, name: string): Promise<string | undefined> {
  const clean = name.trim().slice(0, 80);
  if (!clean) return;
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

/** "Not this person" for some photos: their faces in this group leave it. */
export async function removeFromPerson(person: Person, faceKeys: string[]) {
  await change((d) => {
    const p = d.people.find((x) => x.id === person.id);
    if (!p) return;
    const out = new Set(faceKeys);
    p.anchors = p.anchors.filter((k) => !out.has(k));
    p.rejects = [...new Set([...p.rejects, ...faceKeys])].slice(-2000);
  });
}

export async function setHidden(g: Group, hidden: boolean): Promise<string> {
  const id = g.person?.id ?? await newId();
  await change((d) => {
    const p = d.people.find((x) => x.id === id);
    if (p) p.hidden = hidden;
    else d.people.push({ id, name: "", hidden, anchors: take(g.faces), rejects: [] });
  });
  return id;
}

/** Explicit search on or off for the account: all its devices switch model. Turned on, the indexing device indexes
 *  the library with LAION too; turned off, MobileCLIP's index is there already. */
export async function setExplicit(on: boolean) {
  let was = false;
  await change((d) => { was = d.explicit === true; if (on) d.explicit = true; else delete d.explicit; });
  // MobileCLIP's entries stay: the indexing device keeps them current next to LAION's, for the devices that can't use
  // explicit search (docs/SEARCH.md). Turned off, LAION's go (they are kept per model); best effort
  if (was && !on) await api("DELETE", "/api/index?model=laionb32").catch(() => {});
}

export async function forgetPerson(person: Person) {
  await change((d) => { d.people = d.people.filter((x) => x.id !== person.id); });
}

// ---- grouping ----

let groups: Group[] = [];
let groupsAt = -1;
let ver = 0;
const subs = new Set<() => void>();
const bump = () => { ver++; groupsAt = -1; subs.forEach((f) => f()); };

/** The groups for the people list, worked out again when the index or the people document changed. */
export async function peopleGroups(): Promise<Group[]> {
  const st = await loadSettings();
  if (!st.enabled || !st.faces || !searchReady()) return [];
  if (!loaded) await loadPeople().catch(() => {});
  const at = indexVersion() * 1000 + ver;
  if (groupsAt === at) return groups;
  const anchors: Record<string, string[]> = {}, rejects: Record<string, string[]> = {};
  for (const p of doc.people) { anchors[p.id] = p.anchors; rejects[p.id] = p.rejects; }
  // every group, also those under three photos: the viewer names the faces of one photo from these
  const raw = await N.indexCluster(THRESHOLD, anchors, rejects, 1);
  const live = new Set(libraryItems().map((i) => i.id));
  const byId = new Map(doc.people.map((p) => [p.id, p]));
  const seen = new Set<string>();
  allGroups = raw.map((g, i) => {
    const person = g.person ? byId.get(g.person) : undefined;
    return { key: person?.id ?? `g${i}:${g.cover?.key}`, person, items: g.items.filter((x) => live.has(x)), faces: g.faces, cover: g.cover };
  }).filter((g) => g.items.length && (!g.person || !seen.has(g.person.id) && seen.add(g.person.id)));
  groups = allGroups.filter((g) => g.person || g.items.length >= MIN_FACES);
  groupsAt = at;
  return groups;
}

let allGroups: Group[] = [];

/** Every face found in a photo, with the person or group it belongs to (if any), for the viewer's info. */
export interface FaceInPhoto { key: string; cover: NonNullable<FaceGroup["cover"]>; group?: Group }
export async function facesIn(itemId: string): Promise<FaceInPhoto[]> {
  await peopleGroups();
  return N.indexFacesOf(itemId).map((f) => ({ key: f.key, cover: { key: f.key, item: itemId, box: f.box }, group: allGroups.find((g) => g.faces.includes(f.key)) }));
}

/** Names the person of one face: its group, someone who already has that name, or a new person of just this face. */
export async function nameFace(f: FaceInPhoto, name: string): Promise<string | undefined> {
  const clean = name.trim().slice(0, 80);
  if (!clean) return;
  if (!loaded) await loadPeople();
  const same = doc.people.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (f.group && !f.group.person && same) { await mergeInto(f.group, same); return same.id; }
  if (f.group) return nameGroup(f.group, clean);
  const id = same?.id ?? await newId();
  await change((d) => {
    const p = d.people.find((x) => x.id === id);
    if (p) { p.anchors = [...new Set([...p.anchors, f.key])].slice(-400); p.rejects = p.rejects.filter((k) => k !== f.key); }
    else d.people.push({ id, name: clean, anchors: [f.key], rejects: [] });
  });
  return id;
}

export function usePeople(): { groups: Group[] | null; reload: () => void } {
  const [list, setList] = useState<Group[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    peopleGroups().then((g) => live && setList(g), () => live && setList([]));
    const f = () => setTick((t) => t + 1);
    subs.add(f);
    return () => { live = false; subs.delete(f); };
  }, [tick, indexVersion()]);
  return { groups: list, reload: () => setTick((t) => t + 1) };
}

/** The people in one photo, by name where they have one. */
export async function peopleIn(itemId: string): Promise<Group[]> {
  const gs = await peopleGroups();
  return gs.filter((g) => g.items.includes(itemId) && !g.person?.hidden);
}

// ---- face pictures, cropped from the decrypted thumbnail, in memory only ----

const crops = new Map<string, string>();
export async function faceUri(cover: NonNullable<FaceGroup["cover"]>): Promise<string | null> {
  const hit = crops.get(cover.key);
  if (hit) return hit;
  const it = libraryItems().find((i) => i.id === cover.item);
  if (!it) return null;
  const bytes = await thumbBytes(it);
  try {
    const jpeg = await N.faceCrop(bytes, cover.box, 192);
    if (!jpeg || !session().masterKey) return null;
    const uri = "data:image/jpeg;base64," + N.base64(jpeg);
    jpeg.fill(0);
    crops.set(cover.key, uri);
    if (crops.size > 300) crops.delete(crops.keys().next().value!);
    return uri;
  } finally {
    bytes.fill(0);
  }
}

export const personName = (g: Group) => g.person?.name || "";

onWipe(() => { crops.clear(); groups = []; allGroups = []; groupsAt = -1; doc = { v: 1, people: [] }; version = 0; loaded = false; });
