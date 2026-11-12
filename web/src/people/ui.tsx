import { useEffect, useRef, useState } from "preact/hooks";
import type { Item } from "../items";
import { cachedPreview, cachedThumb, dropImage, thumbUrl, wantImage } from "../cache";
import { pictureKey } from "../edit/edit";
import { Icon } from "../icons";
import { useAction } from "../components";
import { Loader, Loading } from "../loader";
import { faceCrop, facesIn, hasIndex, knownNames, MAX_NAME, nameFace, nameGroup, type FaceInPhoto, type Group } from "./people";
import type { Cover } from "./faces";

export const NO_INDEX = "Turn on search in the Android or Mac app to find the faces in your photos.";

/** The decrypted image a face is cut from: the preview when it is at hand (sharper), else the thumbnail. */
async function imageOf(it: Item): Promise<string> {
  const have = cachedPreview(it) ?? cachedThumb(it);
  if (have) return have;
  wantImage("thumb", it.id);
  try { return await thumbUrl(it); } finally { dropImage("thumb", it.id); }
}

/** A round face, cropped in this browser from the photo's decrypted image. */
export function Face(p: { cover?: Cover; item?: Item; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (p.cover && p.item && !p.item.broken && p.item.has_thumb) {
      imageOf(p.item).then((src) => faceCrop(p.cover!, src)).then((u) => alive && setUrl(u), () => {});
    }
    return () => { alive = false; };
  }, [p.cover?.key, p.item && pictureKey(p.item.id, p.item.meta)]);
  const size = p.size ?? 44;
  return (
    <span class="face" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name="user" size={Math.round(size / 2)} />}
    </span>
  );
}

function NameForm(p: { id: string; initial?: string; label: string; save: (name: string) => Promise<void>; cancel: () => void }) {
  const [name, setName] = useState(p.initial ?? "");
  const { busy, error, run } = useAction();
  const names = knownNames();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    // saved or cancelled: focus goes to the button that now stands where the form was (Rename, the name), not the page
    const box = input.current?.closest("form")?.parentElement;
    return () => {
      setTimeout(() => {
        const at = box?.isConnected ? box : document.querySelector(".personhead"); // a renamed person's header is drawn anew
        if (at && !at.contains(document.activeElement)) at.querySelector<HTMLElement>("button")?.focus();
      });
    };
  }, []);
  return (
    <form class="nameform" onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(() => p.save(name)); }}>
      <label class="sr" for={p.id}>{p.label}</label>
      <input ref={input} id={p.id} type="text" value={name} maxLength={MAX_NAME} autocomplete="off" placeholder="Name" list={names.length ? `${p.id}-names` : undefined}
        onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); p.cancel(); } }} />
      {names.length > 0 && <datalist id={`${p.id}-names`}>{names.map((n) => <option key={n} value={n} />)}</datalist>}
      <div class="row">
        <button class="btn small" type="submit" disabled={busy || !name.trim()}>{busy ? <><Loader />Saving…</> : "Save"}</button>
        <button class="btn secondary small" type="button" onClick={p.cancel}>Cancel</button>
      </div>
      {error && <p class="error" role="alert">{error}</p>}
    </form>
  );
}

/** Who is in this photo, for the lightbox's info panel: every face, named or not. */
export function PhotoPeople(p: { item: Item; all: Group[]; ready: boolean; onPerson: (key: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setEditing(null), [p.item.id]);
  if (!p.ready) return null;
  if (!hasIndex()) return <div><dt>People</dt><dd class="small">{NO_INDEX}</dd></div>;
  const faces = facesIn(p.item.id, p.all);
  if (!faces.length) return <div><dt>People</dt><dd class="small">No faces found in this {p.item.kind === "video" ? "video" : "photo"} yet.</dd></div>;
  const save = (f: FaceInPhoto) => async (name: string) => { await nameFace(f, name); setEditing(null); };
  return (
    <div>
      <dt>People</dt>
      <dd>
        <ul class="facelist" aria-label="People in this photo">
          {faces.map((f, i) => {
            const named = f.group?.person?.name;
            return (
              <li key={f.key}>
                <Face cover={f.cover} item={p.item} size={44} />
                {editing === f.key ? (
                  <NameForm id={`face-${i}`} label="Name this person" initial={named} save={save(f)} cancel={() => setEditing(null)} />
                ) : named ? (
                  <span class="facename">
                    {f.group!.items.length > 0 ? <button class="link" onClick={() => p.onPerson(f.group!.key)}>{named}</button> : <span>{named}</span>}
                    <button class="iconbtn tiny" aria-label={`Rename ${named}`} title="Rename" onClick={() => setEditing(f.key)}><Icon name="edit" size={16} /></button>
                  </span>
                ) : (
                  <button class="link" onClick={() => setEditing(f.key)}>Add name</button>
                )}
              </li>
            );
          })}
        </ul>
      </dd>
    </div>
  );
}

/** The People page: named people first, then groups not named yet. */
export function PeopleList(p: { groups: Group[] | null; ready: boolean; error: string; byId: Map<string, Item>; onOpen: (key: string) => void }) {
  if (p.error && !p.groups) return <p class="error" role="alert">{p.error}</p>;
  if (!p.ready || !p.groups) return <Loading label="Loading people…" />;
  if (!hasIndex()) {
    return (
      <section class="panel empty">
        <span class="emptyicon"><Icon name="users" size={32} /></span>
        <h2>No people yet</h2>
        <p>{NO_INDEX}</p>
      </section>
    );
  }
  const named = p.groups.filter((g) => g.person?.name).sort((a, b) => a.person!.name.localeCompare(b.person!.name));
  const others = p.groups.filter((g) => !g.person?.name);
  if (!named.length && !others.length) {
    return (
      <section class="panel empty">
        <span class="emptyicon"><Icon name="users" size={32} /></span>
        <h2>No people yet</h2>
        <p>Someone shows up here once their face is in at least three photos. Your Android or Mac app may still be looking.</p>
      </section>
    );
  }
  const card = (g: Group) => (
    <li key={g.key}>
      <button class="personcard" onClick={() => p.onOpen(g.key)}>
        <Face cover={g.cover} item={g.cover && p.byId.get(g.cover.item)} size={120} />
        <span class={"pname" + (g.person?.name ? "" : " unnamed")} dir="auto">{g.person?.name || "Add name"}</span>
        <span class="small">{g.items.length} {g.items.length === 1 ? "photo" : "photos"}</span>
      </button>
    </li>
  );
  return (
    <div>
      {named.length > 0 && <ul class="persons" aria-label="People">{named.map(card)}</ul>}
      {others.length > 0 && (
        <>
          <h2 class="peoplehead">Not named yet</h2>
          <ul class="persons" aria-label="People not named yet">{others.map(card)}</ul>
        </>
      )}
      <p class="small">Faces are found by your Android or Mac app. Faces and names are stored encrypted and shared by your devices.</p>
    </div>
  );
}

/** Above a person's photos: their face, and naming or renaming them. */
export function PersonHeader(p: { group: Group; item?: Item; onRenamed: (key: string) => void }) {
  const [editing, setEditing] = useState(false);
  const name = p.group.person?.name;
  return (
    <header class="personhead">
      <Face cover={p.group.cover} item={p.item} size={64} />
      {editing ? (
        <NameForm id="person-name" label={name ? "New name" : "Name this person"} initial={name}
          save={async (n) => { const id = await nameGroup(p.group, n); setEditing(false); if (id) p.onRenamed(id); }}
          cancel={() => setEditing(false)} />
      ) : (
        <button class="btn secondary small" onClick={() => setEditing(true)}><Icon name="edit" size={18} />{name ? "Rename" : "Add name"}</button>
      )}
    </header>
  );
}
