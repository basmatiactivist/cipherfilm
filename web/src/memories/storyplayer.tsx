// The year in review (story.ts) and the custom reviews (custom.ts) played as a story: full screen on black, one picture
// at a time, a progress bar per slide. Loaded when a "Your years" or "Your reviews" card is opened. Worked out in this browser from the decrypted library; the
// pictures are the same decrypted thumbnails and previews the viewer shows (cache.ts, object URLs in memory only).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Item } from "../items";
import { cachedPreview, cachedThumb, dropImage, previewUrl, thumbUrl, wantImage } from "../cache";
import { pictureKey } from "../edit/edit";
import { Icon } from "../icons";
import { Loading } from "../loader";
import { Face } from "../people/ui";
import type { Trip } from "./trips";
import { yearRecap, type Recap } from "./recap";
import { photosOf, slideMs, storySlides, PHOTO_MS, SLIDE_MS, type Slide } from "./story";
import type { JSX } from "preact";
import { reviewSlides, type Every, type Review, type ReviewSlide } from "./custom";
import { tripTitle, usePlaceNames, type RecapPerson } from "./auto";

const monthFmt = new Intl.DateTimeFormat("en", { month: "long" });
const n = (k: number, one: string, many: string) => `${k.toLocaleString("en")} ${k === 1 ? one : many}`;
const FADE_MS = 600;
const HOLD_MS = 220;
/** How long the story waits for the place names and trips before it starts without them. */
const WAIT_MS = 4000;

interface Props {
  year: number;
  items: Item[];
  people: RecapPerson[];
  trips: Trip<Item>[] | null;
  /** a viewer is open over the story: it pauses */
  covered: boolean;
  onClose: () => void;
  onOpenPhoto: (list: Item[], i: number) => void;
  onOpenPerson: (key: string) => void;
  onAllHighlights: () => void;
}

/** A picture: the thumbnail at once, the sharp preview when it has loaded. */
function Pic(p: { item: Item }) {
  const it = p.item;
  const [url, setUrl] = useState<string | undefined>(() => cachedPreview(it) ?? cachedThumb(it));
  useEffect(() => {
    let alive = true;
    let sharp = !!cachedPreview(it);
    setUrl(cachedPreview(it) ?? cachedThumb(it));
    if (sharp || it.broken) return;
    if (it.has_thumb && !cachedThumb(it)) {
      wantImage("thumb", it.id);
      thumbUrl(it).then((u) => { if (alive && !sharp) setUrl(u); }, () => {}).finally(() => dropImage("thumb", it.id));
    }
    if (it.has_preview) previewUrl(it).then((u) => { sharp = true; if (alive) setUrl(u); }, () => {});
    return () => { alive = false; };
  }, [pictureKey(it.id, it.meta)]);
  return url ? <img src={url} alt="" draggable={false} /> : null;
}

/** The next picture's preview (or thumbnail), fetched ahead. */
function preload(it: Item | undefined) {
  if (!it || it.broken) return;
  if (it.has_preview) { if (!cachedPreview(it)) previewUrl(it).catch(() => {}); return; }
  if (it.has_thumb && !cachedThumb(it)) { wantImage("thumb", it.id); thumbUrl(it).catch(() => {}).finally(() => dropImage("thumb", it.id)); }
}

export function Story(p: Props) {
  const names = usePlaceNames();
  const [waited, setWaited] = useState(false);
  useEffect(() => { const t = setTimeout(() => setWaited(true), WAIT_MS); return () => clearTimeout(t); }, []);
  // worked out once when the names and trips are there, so a library change doesn't reshuffle a playing story
  const [story, setStory] = useState<{ r: Recap<Item>; slides: Slide<Item>[] } | null | undefined>(undefined);
  useEffect(() => {
    if (story !== undefined || !((names && p.trips !== null) || waited)) return;
    const r = yearRecap(p.items, p.year, { lookup: names ?? undefined, people: p.people });
    setStory(r ? { r, slides: storySlides(r, { trips: p.trips ?? [], named: new Set(p.people.map((x) => x.key)) }) } : null);
  }, [names, p.trips, waited]);
  const tripsBy = useMemo(() => new Map((p.trips ?? []).map((t) => [t.key, t])), [p.trips]);
  const people = useMemo(() => new Map(p.people.map((x) => [x.key, x])), [p.people]);
  const byId = useMemo(() => new Map(p.items.map((i) => [i.id, i])), [p.items]);

  const label = (s: Slide<Item>, ph: number): string => {
    const year = p.year;
    switch (s.kind) {
      case "cover": return `${year} in review. ${facts().join(", ")}`;
      case "month": return `${monthFmt.format(new Date(year, s.month, 1))} ${year}, ${n(s.total, "item", "items")}` + (s.photos.length > 1 ? `, photo ${ph + 1} of ${s.photos.length}` : "");
      case "trip": { const t = tripsBy.get(s.key); return `${t ? tripTitle(t) : "Trip"}, ${n(s.count, "item", "items")}`; }
      case "places": return `Where you were most: ${s.name}, ${s.country}` + (s.others.length ? `. Also ${s.others.join(", ")}` : "");
      case "people": return "With you this year: " + s.people.map((x) => `${people.get(x.key)?.name ?? ""}, ${n(x.count, "photo", "photos")}`).join("; ");
      case "end": return `That was ${year}`;
    }
  };
  const facts = () => {
    const r = story?.r;
    if (!r) return [];
    return [n(r.photos, "photo", "photos"), r.videos ? n(r.videos, "video", "videos") : "", n(r.days, "day with photos", "days with photos"), r.countries > 1 ? n(r.countries, "country", "countries") : ""].filter(Boolean);
  };

  const text = (s: Slide<Item>, restart: () => void) => {
    switch (s.kind) {
      case "cover": return (
        <div class="sttext stcap stcover">
          <h2 class="stbig">{p.year}</h2>
          <p>{facts().join(" · ")}</p>
        </div>
      );
      case "month": return (
        <div class="sttext stcap">
          <h2>{monthFmt.format(new Date(p.year, s.month, 1))}</h2>
          <p>{n(s.total, "item", "items")}</p>
        </div>
      );
      case "trip": { const t = tripsBy.get(s.key); return (
        <div class="sttext stcap">
          <h2 dir="auto">{t ? tripTitle(t) : "Trip"}</h2>
          <p>{n(s.count, "item", "items")}</p>
        </div>
      ); }
      case "places": return (
        <div class="sttext stcap">
          <p class="stkicker">Where you were most</p>
          <h2 dir="auto">{s.name}, {s.country}</h2>
          {s.others.length > 0 && <p dir="auto">{s.others.join(" · ")}</p>}
        </div>
      );
      case "people": return (
        <div class="sttext stcenter">
          <h2>With you this year</h2>
          <ul class="stpeople">
            {s.people.map((x) => {
              const who = people.get(x.key);
              return (
                <li key={x.key}>
                  <button class="stperson" onClick={() => p.onOpenPerson(x.key)} aria-label={`${who?.name ?? ""}, ${n(x.count, "photo", "photos")}`}>
                    <Face cover={who?.cover} item={who?.cover && byId.get(who.cover.item)} size={88} />
                    <span class="stname" dir="auto">{who?.name}</span>
                    <span class="stcount">{n(x.count, "photo", "photos")}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      );
      case "end": return (
        <div class="sttext stcenter">
          <h2 class="stbig">That was {p.year}</h2>
          <div class="stend">
            <button class="btn" onClick={restart}><Icon name="restore" size={18} />Watch again</button>
            <button class="stbtn" onClick={p.onAllHighlights}>All highlights</button>
            <button class="stbtn" onClick={p.onClose}>Close</button>
          </div>
        </div>
      );
    }
  };

  return (
    <Player<Slide<Item>> slides={story === undefined ? undefined : story?.slides ?? []} title={`${p.year} in review`} badge={String(p.year)}
      loading={`Opening ${p.year}…`} empty={<h2>No photos from {p.year}</h2>} photos={photosOf} ms={slideMs} isEnd={(s) => s.kind === "end"}
      label={label} text={text} covered={p.covered} onClose={p.onClose} onOpenPhoto={p.onOpenPhoto} />
  );
}

/** What the player needs to know about a kind of slide. */
interface PlayerProps<S> {
  /** undefined while they're worked out; empty: nothing to show */
  slides: S[] | undefined;
  /** the dialog's name, and the text at the top left */
  title: string;
  badge: string;
  loading: string;
  empty: JSX.Element;
  photos: (s: S) => Item[];
  ms: (s: S) => number;
  isEnd: (s: S) => boolean;
  label: (s: S, photo: number) => string;
  text: (s: S, restart: () => void) => JSX.Element;
  covered: boolean;
  onClose: () => void;
  onOpenPhoto: (list: Item[], i: number) => void;
}

function Player<S>(p: PlayerProps<S>) {
  const slides = p.slides ?? [];
  const reduced = useMemo(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [idx, setIdx] = useState(0);
  const [photo, setPhoto] = useState(0);
  const photoNow = useRef(0);
  photoNow.current = photo;
  const [playing, setPlaying] = useState(!reduced);
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  // the picture going away, under the new one while it fades in
  const [under, setUnder] = useState<{ idx: number; photo: number } | null>(null);
  const elapsed = useRef(0);
  const fill = useRef<HTMLSpanElement>(null);
  const fadeT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const idxNow = useRef(0);
  idxNow.current = idx;
  const slide = slides[idx] as S | undefined;
  const running = !!slide && !p.isEnd(slide) && playing && !held && !hidden && !p.covered;

  const leave = (from: { idx: number; photo: number }) => {
    setUnder(from);
    clearTimeout(fadeT.current);
    fadeT.current = setTimeout(() => setUnder(null), FADE_MS);
  };
  const go = (i: number) => {
    if (!slides.length) return;
    const to = Math.max(0, Math.min(slides.length - 1, i));
    elapsed.current = 0;
    if (to !== idxNow.current) leave({ idx: idxNow.current, photo: photoNow.current });
    idxNow.current = to;
    photoNow.current = 0;
    setIdx(to);
    setPhoto(0);
  };
  const step = (d: number) => go(idxNow.current + d);
  const restart = () => { go(0); setPlaying(true); };

  // the full-screen layer: modal (focus stays in it), and on close focus goes back to the card it was opened from
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dlg.current!;
    const back = document.activeElement as HTMLElement | null;
    d.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
      d.close();
      clearTimeout(fadeT.current);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  // once it is ready, focus on Pause/Play (Space works there too)
  useEffect(() => { if (p.slides) dlg.current?.querySelector<HTMLElement>(".stplay")?.focus(); }, [!!p.slides]);
  // a viewer opened from the story has closed: focus comes back to the story
  useEffect(() => {
    if (p.covered) return;
    const t = setTimeout(() => { const d = dlg.current; if (d && !d.contains(document.activeElement)) d.querySelector<HTMLElement>(".stopen, .stplay")?.focus(); }, 60);
    return () => clearTimeout(t);
  }, [p.covered]);
  // paused while the tab is in the background
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // the clock: the current bar fills frame by frame, a month's photos change on time, then the next slide
  useEffect(() => {
    if (!slide) return;
    const dur = p.ms(slide);
    const count = p.photos(slide).length;
    const paint = () => { if (fill.current) fill.current.style.transform = `scaleX(${p.isEnd(slide) ? 1 : Math.min(1, elapsed.current / dur)})`; };
    paint();
    if (!running) return;
    let last = performance.now();
    let raf = 0;
    let shown = photo;
    const tick = (now: number) => {
      elapsed.current += Math.min(now - last, 250); // a long gap (a throttled frame, a busy tab) doesn't skip ahead
      last = now;
      paint();
      if (count > 1) {
        const k = Math.min(count - 1, Math.floor(elapsed.current / (dur / count)));
        if (k !== shown) { leave({ idx, photo: shown }); shown = photoNow.current = k; setPhoto(k); }
      }
      if (elapsed.current >= dur) { go(idx + 1); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [idx, running, slides]);

  // the next slide's first picture, and the rest of this one's, fetched ahead
  useEffect(() => {
    if (!slide) return;
    p.photos(slide).slice(1).forEach(preload);
    preload(slides[idx + 1] && p.photos(slides[idx + 1])[0]);
  }, [idx, slides]);

  // tap: right two thirds next, left third back; hold: paused while held; swipe down (touch): close
  const press = useRef<{ x: number; y: number; t: ReturnType<typeof setTimeout>; held: boolean } | null>(null);
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const pr = { x: e.clientX, y: e.clientY, held: false, t: setTimeout(() => { pr.held = true; setHeld(true); }, HOLD_MS) };
    press.current = pr;
  };
  const onUp = (e: PointerEvent) => {
    const pr = press.current;
    press.current = null;
    if (!pr) return;
    clearTimeout(pr.t);
    setHeld(false);
    const dx = e.clientX - pr.x, dy = e.clientY - pr.y;
    if (e.pointerType !== "mouse" && dy > 80 && Math.abs(dx) < dy) { p.onClose(); return; }
    if (pr.held || Math.abs(dx) > 30 || Math.abs(dy) > 30) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    step(e.clientX - box.left < box.width / 3 ? -1 : 1);
  };
  const onCancel = () => { const pr = press.current; press.current = null; if (pr) clearTimeout(pr.t); setHeld(false); };

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === " " && !(e.target as HTMLElement | null)?.closest?.("button, a")) { e.preventDefault(); setPlaying((v) => !v); }
  };

  const layer = (at: { idx: number; photo: number }, current: boolean) => {
    const s = slides[at.idx];
    if (!s) return null;
    const list = p.photos(s);
    const it = list[at.photo];
    const ms = p.ms(s) / Math.max(1, list.length);
    return (
      <div key={`${at.idx}:${at.photo}`} class={"stlayer" + (current ? " in" : "")} aria-hidden="true">
        {it && <div class="stzoom" style={{ "--st-ms": `${ms}ms` }}><Pic item={it} /></div>}
      </div>
    );
  };

  const current = slide ? p.photos(slide)[photo] : undefined;
  const openCurrent = () => {
    if (!slide || !current) return;
    const list = p.photos(slide);
    if (list.length > 1) p.onOpenPhoto(list, photo);
    else p.onOpenPhoto([current], 0);
  };

  return (
    <dialog ref={dlg} class={"story" + (running ? "" : " paused") + (reduced ? " rm" : "")} aria-label={p.title}
      onCancel={(e) => { e.preventDefault(); p.onClose(); }} onKeyDown={onKey}>
      <div class="stcol">
        {p.slides === undefined ? <Loading stage label={p.loading} /> : !slide ? (
          <div class="sttext stcenter">{p.empty}<button class="stbtn" onClick={p.onClose}>Close</button></div>
        ) : (
          <>
            <div class="stlayers">
              {under && (under.idx !== idx || under.photo !== photo) ? layer(under, false) : null}
              {layer({ idx, photo }, true)}
            </div>
            <div class={"stshade" + (p.photos(slide).length ? "" : " dark")} aria-hidden="true" />
            <div class="sttap" aria-hidden="true" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={onCancel} onContextMenu={(e) => e.preventDefault()} />
            <div class="sttop">
              <div class="stbars" aria-hidden="true">
                {slides.map((_, i) => <span key={i} class="stbar"><span ref={i === idx ? fill : undefined} style={i === idx ? undefined : { transform: i < idx ? "none" : "scaleX(0)" }} /></span>)}
              </div>
              <div class="strow">
                <span class="styear" dir="auto">{p.badge}</span>
                <button class="lbbtn stplay" onClick={() => setPlaying((v) => !v)} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>
                  <Icon name={playing ? "pause" : "play"} />
                </button>
                <button class="lbbtn" onClick={p.onClose} aria-label="Close" title="Close (Esc)"><Icon name="x" /></button>
              </div>
            </div>
            <div key={idx} class="stslide" role="group" aria-roledescription="slide" aria-label={p.label(slide, photo)}>
              {p.text(slide, restart)}
            </div>
            <p class="sr" aria-live="polite">{p.label(slide, 0)}, {idx + 1} of {slides.length}</p>
            {current && (
              <button class="stopen" onClick={openCurrent} aria-label={`Open ${current.meta?.name ?? "photo"}`}><Icon name="expand" size={18} />Open</button>
            )}
            <button class="nav prev stnav" onClick={() => step(-1)} disabled={idx === 0} aria-label="Previous"><Icon name="back" /></button>
            <button class="nav next stnav" onClick={() => step(1)} disabled={idx === slides.length - 1} aria-label="Next"><Icon name="next" /></button>
          </>
        )}
      </div>
    </dialog>
  );
}

/** Which period a review's story is of: "Today", "This week", "November 2026". */
export const periodName = (every: Every, now = new Date()) =>
  every === "day" ? "Today" : every === "week" ? "This week" : `${monthFmt.format(now)} ${now.getFullYear()}`;
const nextName = (every: Every) => (every === "day" ? "tomorrow" : every === "week" ? "next week" : "next month");
const reviewMs = (s: ReviewSlide<Item>) => (s.kind === "ryear" ? Math.max(SLIDE_MS, PHOTO_MS * s.photos.length) : SLIDE_MS);
const reviewPhotos = (s: ReviewSlide<Item>): Item[] => (s.kind === "ryear" ? s.photos : s.kind === "rcover" ? [s.item] : []);

/** A custom review as a story. picked: the photos this period shows (undefined while the search runs); total: how
 *  many match the search. */
export function ReviewStory(p: { review: Review; picked: Item[] | undefined; total: number; covered: boolean; onClose: () => void; onEdit: () => void; onOpenPhoto: (list: Item[], i: number) => void }) {
  const r = p.review;
  const slides = useMemo(() => (!p.picked ? undefined : p.picked.length ? reviewSlides(r, p.picked, p.total) : []), [p.picked]);
  const label = (s: ReviewSlide<Item>, ph: number): string => {
    switch (s.kind) {
      case "rcover": return `${r.name}. ${periodName(r.every)}. ${s.shown} of ${n(s.total, "photo", "photos")}`;
      case "ryear": return `${s.year}` + (s.photos.length > 1 ? `, photo ${ph + 1} of ${s.photos.length}` : "");
      case "rend": return `Next one ${nextName(r.every)}`;
    }
  };
  const text = (s: ReviewSlide<Item>, restart: () => void) => {
    switch (s.kind) {
      case "rcover": return (
        <div class="sttext stcap stcover">
          <p class="stkicker">{periodName(r.every)}</p>
          <h2 class="stbig" dir="auto">{r.name}</h2>
          <p>{s.shown.toLocaleString("en")} of {n(s.total, "photo", "photos")}</p>
        </div>
      );
      case "ryear": return (
        <div class="sttext stcap">
          <h2>{s.year}</h2>
        </div>
      );
      case "rend": return (
        <div class="sttext stcenter">
          <h2 class="stbig">Next one {nextName(r.every)}</h2>
          <div class="stend">
            {(slides?.length ?? 0) > 1 && <button class="btn" onClick={restart}><Icon name="restore" size={18} />Watch again</button>}
            <button class="stbtn" onClick={p.onEdit}>Edit review</button>
            <button class="stbtn" onClick={p.onClose}>Close</button>
          </div>
        </div>
      );
    }
  };
  return (
    <Player<ReviewSlide<Item>> slides={slides} title={r.name} badge={r.name} loading={`Finding photos for “${r.name}”…`}
      empty={<h2 dir="auto">No photos for “{r.name}” right now</h2>} photos={reviewPhotos} ms={reviewMs} isEnd={(s) => s.kind === "rend"}
      label={label} text={text} covered={p.covered} onClose={p.onClose} onOpenPhoto={p.onOpenPhoto} />
  );
}
