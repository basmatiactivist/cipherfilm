// Custom reviews on the web: the "Your reviews" row above "Your years", and the menu to make, change and delete them
// (custom.ts has the rules, reviews.ts the encrypted document). The search runs here like the search box does
// (library.tsx findFor): nothing about a review leaves this browser except in the encrypted document.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Item } from "../items";
import { Tile } from "../grid";
import { Icon } from "../icons";
import { COUNTS, MAX_REVIEWS, MAX_TEXT, isDue, nextDue, type Every, type Review, type ReviewDoc } from "./custom";
import { draft, removeReview, saveReview } from "./reviews";

const EVERY_NAME: Record<Every, string> = { day: "Daily", week: "Weekly", month: "Monthly" };
const dayFmt = new Intl.DateTimeFormat("en", { weekday: "long" });
const dateFmt = new Intl.DateTimeFormat("en", { day: "numeric", month: "long" });

/** "Due now", "Next: tomorrow", "Next: Monday", "Next: 1 December". */
export function whenText(r: Review, doc: ReviewDoc, now = new Date()): string {
  if (isDue(r, doc, now)) return "Due now";
  const next = nextDue(r, doc, now);
  const days = Math.round((new Date(next.getFullYear(), next.getMonth(), next.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  return `Next: ${days <= 1 ? "tomorrow" : days < 7 ? dayFmt.format(next) : dateFmt.format(next)}`;
}

/** Due first, then the one due soonest, then by name. */
export function ordered(doc: ReviewDoc, now = new Date()): Review[] {
  return [...doc.reviews].sort((a, b) => nextDue(a, doc, now).getTime() - nextDue(b, doc, now).getTime() || a.name.localeCompare(b.name));
}

/** The row on the timeline: a card for each review, due ones first; a card to manage them. */
export function ReviewsRow(p: { doc: ReviewDoc; byId: Map<string, Item>; onOpen: (r: Review) => void; onManage: () => void }) {
  if (!p.doc.reviews.length) return null;
  const now = new Date();
  return (
    <section class="memories" aria-labelledby="reviewshead">
      <div class="memheadrow">
        <h2 class="memhead" id="reviewshead">Your reviews</h2>
        <button class="link small" onClick={p.onManage}>Manage</button>
      </div>
      <ul class="memrow">
        {ordered(p.doc, now).map((r) => {
          const cover = (p.doc.shown[r.id]?.now ?? []).map((id) => p.byId.get(id)).find((i) => i && !i.broken && i.has_thumb);
          const when = whenText(r, p.doc, now);
          return (
            <li key={r.id}>
              <button class={"memcard" + (isDue(r, p.doc, now) ? " due" : "")} onClick={() => p.onOpen(r)} aria-label={`${r.name}, ${EVERY_NAME[r.every].toLowerCase()}, ${when}`}>
                <span class="cover">{cover ? <Tile plain item={cover} selectMode={false} selected={false} onOpen={() => {}} onToggle={() => {}} /> : <span class="memblank"><Icon name="photos" size={28} /></span>}</span>
                <span class="memago" dir="auto">{r.name}</span>
                <span class="small">{when}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The menu: the reviews, and a form to make or change one. count: how many photos a search finds here. */
export function ReviewsDialog(p: { doc: ReviewDoc | null; error: string; start?: Review | "new"; count: (query: string) => Promise<number>; onPlay: (r: Review) => void; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [edit, setEdit] = useState<Review | null>(p.start === "new" ? draft() : p.start ?? null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dlg.current!.showModal();
    return () => setTimeout(() => opener?.isConnected && opener.focus());
  }, []);
  const close = () => (edit && p.start === undefined ? setEdit(null) : p.onClose());
  return (
    <dialog ref={dlg} class="helpdlg reviewsdlg" aria-labelledby="reviews-title" onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => { if (e.target === dlg.current) p.onClose(); }}>
      <div class="helphead">
        <h2 id="reviews-title"><Icon name="photos" />{edit ? (edit.id ? "Edit review" : "New review") : "Custom reviews"}</h2>
        <button class="iconbtn" aria-label="Close" onClick={p.onClose}><Icon name="x" /></button>
      </div>
      {edit ? <Form key={edit.id || "new"} review={edit} count={p.count} onDone={() => (p.start !== undefined ? p.onClose() : setEdit(null))} />
        : <List doc={p.doc} error={p.error} onEdit={setEdit} onPlay={p.onPlay} />}
    </dialog>
  );
}

function List(p: { doc: ReviewDoc | null; error: string; onEdit: (r: Review) => void; onPlay: (r: Review) => void }) {
  if (!p.doc) return p.error ? <p class="error" role="alert">{p.error}</p> : <p class="small">Loading…</p>;
  const now = new Date();
  return (
    <>
      <p class="small">A search you save, played as a story like the year in review: daily, weekly or monthly, with other photos each time. Worked out in this browser; the server keeps it encrypted and can't read it.</p>
      {p.doc.reviews.length === 0 ? <p>No reviews yet.</p> : (
        <ul class="reviewlist">
          {ordered(p.doc, now).map((r) => (
            <li key={r.id}>
              <button class="reviewitem" onClick={() => p.onEdit(r)}>
                <span class="reviewname" dir="auto">{r.name}</span>
                <span class="small">{EVERY_NAME[r.every]} · {r.count} photos · {whenText(r, p.doc!, now)}</span>
              </button>
              <button class="iconbtn" aria-label={`Play ${r.name}`} title="Play" onClick={() => p.onPlay(r)}><Icon name="play" /></button>
            </li>
          ))}
        </ul>
      )}
      <div class="row">
        <button class="btn" disabled={p.doc.reviews.length >= MAX_REVIEWS} onClick={() => p.onEdit(draft())}>New review</button>
      </div>
      {p.doc.reviews.length >= MAX_REVIEWS && <p class="small">That's the most there can be: {MAX_REVIEWS}.</p>}
    </>
  );
}

function Segs<T extends string | number>(p: { label: string; value: T; options: readonly T[]; name: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <div class="field">
      <span class="fieldlabel" id={`seg-${p.label}`}>{p.label}</span>
      <div class="segs" role="radiogroup" aria-labelledby={`seg-${p.label}`}>
        {p.options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={o === p.value} class={"seg" + (o === p.value ? " on" : "")} onClick={() => p.onChange(o)}>{p.name(o)}</button>
        ))}
      </div>
    </div>
  );
}

function Form(p: { review: Review; count: (query: string) => Promise<number>; onDone: () => void }) {
  const [r, setR] = useState(p.review);
  const [found, setFound] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (o: Partial<Review>) => setR((x) => ({ ...x, ...o }));
  useEffect(() => {
    const q = r.query.trim();
    setFound(null);
    if (!q) return;
    let alive = true;
    const t = setTimeout(() => p.count(q).then((n) => alive && setFound(n), () => alive && setFound(null)), 400);
    return () => { alive = false; clearTimeout(t); };
  }, [r.query]);
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await saveReview(r); p.onDone(); } catch (x) { setError(x instanceof Error ? x.message : "Couldn't save. Try again."); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!confirm(`Delete the review “${r.name}”? This can't be undone.`)) return;
    setBusy(true); setError("");
    try { await removeReview(r.id); p.onDone(); } catch (x) { setError(x instanceof Error ? x.message : "Couldn't delete. Try again."); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save}>
      <div class="field">
        <label for="rv-query">Search for</label>
        <input id="rv-query" type="text" value={r.query} maxLength={MAX_TEXT} required autoFocus placeholder="dogs, Anna in Zürich, beach 2019…" onInput={(e) => set({ query: (e.target as HTMLInputElement).value })} />
        <p class="hint" aria-live="polite">{!r.query.trim() ? "Anything you can search for: words, people, places, dates, text in photos." : found === null ? "Looking…" : found === 0 ? "No photos match right now." : `${found.toLocaleString("en")} ${found === 1 ? "photo matches" : "photos match"}.`}</p>
      </div>
      <Segs label="How often" value={r.every} options={["day", "week", "month"] as const} name={(v) => EVERY_NAME[v]} onChange={(every) => set({ every })} />
      <Segs label="Photos" value={r.count} options={COUNTS} name={String} onChange={(count) => set({ count })} />
      <div class="field">
        <label for="rv-name">Name</label>
        <input id="rv-name" type="text" value={r.name} maxLength={MAX_TEXT} placeholder={r.query.trim() || "The search, if left empty"} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
      </div>
      {error && <p class="error" role="alert">{error}</p>}
      <div class="row">
        <button class="btn" type="submit" disabled={busy || !r.query.trim()}>{r.id ? "Save" : "Create"}</button>
        <button class="btn secondary" type="button" disabled={busy} onClick={() => p.onDone()}>Cancel</button>
        {r.id && <button class="btn danger" type="button" disabled={busy} onClick={del}>Delete</button>}
      </div>
    </form>
  );
}
