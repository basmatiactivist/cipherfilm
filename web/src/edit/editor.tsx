// The editor (docs/EDITING.md): turn and crop a photo, change when and where it was taken. Nothing is changed until
// Save; the original always stays as it was ("Revert to original" brings everything back). Opened from the lightbox.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "../icons";
import { Loading } from "../loader";
import { lazy } from "../lazy";
import { cachedPreview, cachedThumb, previewUrl, thumbUrl } from "../cache";
import type { Item } from "../items";
import type { Decoded, ItemMeta } from "../media";
import { loadPlaces } from "../map/locations";
import { mapOn } from "../map/consent";
import { label, type Place } from "../places/places";
import { canEditPicture, decodeOriginal, drawEdited, saveEdit } from "./apply";
import { dragCrop, isEdited, normEdit, normOrig, ratioRect, reverted, turn, turnedSize, withDate, withPlace, type Edit, type Gps, type Handle, type Rect } from "./edit";

const PickMap = lazy(() => import("../map/ui").then((m) => m.PickMap), () => null);

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const WORK_PX = 1600; // the picture on screen while editing; the saved pictures are drawn from the original
const RATIOS: { label: string; name: string; r: number | null | "orig" }[] = [
  { label: "Free", name: "Free shape", r: null },
  { label: "Original", name: "Shape of the photo", r: "orig" },
  { label: "Square", name: "Square", r: 1 },
  { label: "4:3", name: "4 by 3", r: 4 / 3 },
  { label: "3:4", name: "3 by 4", r: 3 / 4 },
  { label: "16:9", name: "16 by 9", r: 16 / 9 },
  { label: "9:16", name: "9 by 16", r: 9 / 16 },
];
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** "2024-05-01T14:03:09" in this device's time zone, for <input type="datetime-local">. */
export const localInput = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const placeLine = (p: Place) => [p.name, p.region !== p.name ? p.region : "", p.country].filter(Boolean).join(", ");

export function Editor(p: { item: Item; onClose: () => void; onSaved: () => void }) {
  const it = p.item;
  const meta = it.meta!;
  const pictureTools = canEditPicture(it);
  const dlg = useRef<HTMLDialogElement>(null);
  const [edit, setEdit] = useState<Edit | undefined>(meta.edit);
  const [ratio, setRatio] = useState<number | null | "orig">(null);
  const [ts, setTs] = useState(meta.capture_ts);
  const [gps, setGps] = useState<Gps | null>(meta.gps ?? null);
  const [touched, setTouched] = useState({ date: false, place: false, revert: false });
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  const [work, setWork] = useState<HTMLCanvasElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [still, setStill] = useState<string | undefined>(() => cachedPreview(it) ?? cachedThumb(it));

  useEffect(() => {
    const d = dlg.current!;
    d.showModal();
    return () => d.close();
  }, []);

  // photos: the original, decrypted and decoded here (what the saved pictures are drawn from); videos: their still
  useEffect(() => {
    let alive = true, got: Decoded | null = null;
    if (pictureTools) {
      decodeOriginal(it, (done, total) => alive && setProgress(total ? done / total : 0)).then((d) => {
        if (!alive) { d.close(); return; }
        got = d;
        setDecoded(d);
        setWork(drawEdited(d, undefined, WORK_PX));
      }, () => alive && setLoadErr("This photo couldn't be opened for editing here. You can still change its date and place."));
    } else if (it.has_thumb) {
      (it.has_preview ? previewUrl(it) : thumbUrl(it)).then((u) => alive && setStill(u), () => {});
    }
    return () => { alive = false; got?.close(); };
  }, []);

  const rot = normEdit(edit)?.rot ?? 0;
  const crop = edit?.crop ?? FULL;
  const pic = decoded ? turnedSize(decoded.width, decoded.height, rot) : { w: 1, h: 1 };
  const shape = (r: typeof ratio) => (r === "orig" ? pic.w / pic.h : r);

  // the picture on screen: the working copy, turned (the crop is drawn over it)
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !work) return;
    const t = turnedSize(work.width, work.height, rot);
    c.width = t.w; c.height = t.h;
    const ctx = c.getContext("2d")!;
    ctx.translate(t.w / 2, t.h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(work, -work.width / 2, -work.height / 2);
  }, [work, rot]);

  const setCrop = (r: Rect) => setEdit((e) => normEdit({ ...e, crop: r, v: undefined }) ?? undefined);
  const rotate = (by: 90 | -90) => setEdit((e) => {
    let next = turn(e, by);
    const r = shape(ratio);
    if (r && decoded) { // the chosen shape stays, around the same part of the photo
      const t = turnedSize(decoded.width, decoded.height, next?.rot ?? 0);
      next = normEdit({ ...next, crop: ratioRect(r, t.w, t.h, next?.crop) }) ?? undefined;
    }
    return next;
  });
  const chooseRatio = (r: typeof ratio) => {
    setRatio(r);
    const s = shape(r);
    if (s) setCrop(ratioRect(s, pic.w, pic.h, edit?.crop));
  };

  // the picture as large as the stage allows
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const cs = getComputedStyle(el); setRoom({ w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = Math.max(0, Math.min(room.w / pic.w, room.h / pic.h));

  // dragging the frame or one of its handles
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ h: Handle; x: number; y: number; start: Rect; id: number } | null>(null);
  const down = (h: Handle) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { h, x: e.clientX, y: e.clientY, start: crop, id: e.pointerId };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current, b = box.current?.getBoundingClientRect();
    if (!d || !b || d.id !== e.pointerId) return;
    setCrop(dragCrop(d.start, d.h, (e.clientX - d.x) / b.width, (e.clientY - d.y) / b.height, shape(ratio), pic.w / pic.h));
  };
  const up = () => { drag.current = null; };
  const keys = (e: KeyboardEvent) => {
    const step = 0.01;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    setCrop(dragCrop(crop, e.shiftKey ? "se" : "move", dx, dy, shape(ratio), pic.w / pic.h));
  };

  // the place: its name, and places found by name
  const [placeName, setPlaceName] = useState("");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Place[]>([]);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    let alive = true;
    setPlaceName("");
    if (gps) loadPlaces().then((pl) => alive && setPlaceName(label(pl.nearest(gps.lat, gps.lon))), () => {});
    return () => { alive = false; };
  }, [gps?.lat, gps?.lon]);
  useEffect(() => {
    let alive = true;
    if (query.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => loadPlaces().then((pl) => alive && setFound(pl.find(query, 8)), () => {}), 120);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);
  const place = (g: Gps | null) => { setGps(g); setTouched((x) => ({ ...x, place: true })); setQuery(""); setFound([]); };

  const orig = normOrig(meta.orig);
  const revert = () => {
    setEdit(undefined);
    setRatio(null);
    if (orig && "capture_ts" in orig) setTs(orig.capture_ts!);
    if (orig && "gps" in orig) setGps(orig.gps ?? null);
    setTouched({ date: false, place: false, revert: true });
  };

  const next = useMemo((): ItemMeta => {
    let m: ItemMeta = touched.revert ? reverted(meta) : meta;
    if (touched.date && ts !== m.capture_ts) m = withDate(m, ts);
    if (touched.place) m = withPlace(m, gps);
    const e = normEdit(edit);
    m = { ...m };
    if (e) m.edit = e; else delete m.edit;
    return m;
  }, [edit, ts, gps, touched]);
  const changed = JSON.stringify(next) !== JSON.stringify(meta);

  const save = async () => {
    setBusy(true); setErr("");
    try {
      await saveEdit(it, next, decoded);
      p.onSaved();
      p.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save the changes.");
      setBusy(false);
    }
  };

  const name = meta.name;
  return (
    <dialog ref={dlg} class="lightbox editor" aria-label={`Edit ${name}`} onCancel={(e) => { e.preventDefault(); if (!busy) p.onClose(); }}>
      <div class="lbtop">
        <button class="lbbtn" onClick={p.onClose} disabled={busy} aria-label="Cancel"><Icon name="x" /></button>
        <div class="lbtitle"><strong class="lbname" dir="auto">Edit</strong><span class="lbcount" dir="auto">{name}</span></div>
        {pictureTools && (
          <>
            <button class="lbbtn" onClick={() => rotate(-90)} disabled={!decoded || busy} aria-label="Turn left" title="Turn left"><Icon name="turnLeft" /></button>
            <button class="lbbtn" onClick={() => rotate(90)} disabled={!decoded || busy} aria-label="Turn right" title="Turn right"><Icon name="turnRight" /></button>
          </>
        )}
      </div>
      <div class="stage edstage" ref={stage}>
        {pictureTools && work ? (
          <div class="edpic" ref={box} onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ width: `${Math.floor(pic.w * fit)}px`, height: `${Math.floor(pic.h * fit)}px` }}>
            <canvas ref={canvas} aria-hidden="true" />
            <div class="edframe" role="group" tabIndex={0} aria-label="Crop frame. Arrow keys move it, Shift and arrow keys change its size."
              style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
              onPointerDown={down("move")} onKeyDown={keys}>
              {HANDLES.map((h) => <span key={h} class={`edh ${h}`} onPointerDown={down(h)} />)}
            </div>
          </div>
        ) : pictureTools && !loadErr ? (
          <Loading stage label={progress ? `Decrypting the original… ${Math.round(progress * 100)}%` : "Decrypting the original…"} />
        ) : still ? (
          <img src={still} alt={name} draggable={false} />
        ) : null}
      </div>
      <div class="lbbottom">
        {pictureTools && work && (
          <div class="edratios" role="group" aria-label="Crop shape">
            {RATIOS.map((r) => (
              <button key={r.label} class="btn secondary small" aria-pressed={ratio === r.r} aria-label={r.name} onClick={() => chooseRatio(r.r)}>{r.label}</button>
            ))}
            <button class="btn secondary small" disabled={!edit?.crop} onClick={() => { setRatio(null); setEdit((e) => normEdit({ ...e, crop: undefined }) ?? undefined); }}>No crop</button>
          </div>
        )}
      </div>
      <aside class="infopanel edpanel" aria-label="Changes">
        <div class="infohead"><h2><Icon name="edit" size={18} />Edit</h2></div>
        {loadErr && <p class="small">{loadErr}</p>}
        {!pictureTools && it.kind === "video" && <p class="small">For videos you can change the date and the place.</p>}
        <div class="field">
          <label for="ed-when">Taken</label>
          <input id="ed-when" type="datetime-local" step="1" value={localInput(ts)} disabled={busy}
            onChange={(e) => { const v = new Date((e.target as HTMLInputElement).value).getTime(); if (Number.isFinite(v)) { setTs(v); setTouched((x) => ({ ...x, date: true })); } }} />
        </div>
        <div class="field">
          <label for="ed-place">Place</label>
          <p class="edplace" dir="auto">{gps ? (placeName || `${gps.lat.toFixed(4)}, ${gps.lon.toFixed(4)}`) : <span class="small">No place</span>}</p>
          <input id="ed-place" type="text" autocomplete="off" placeholder="Search for a town or city" value={query} disabled={busy}
            aria-controls="ed-found" onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          {found.length > 0 && (
            <ul id="ed-found" class="edfound" aria-label="Places found">
              {found.map((f, i) => <li key={i}><button class="link" dir="auto" onClick={() => place({ lat: f.lat, lon: f.lon })}>{placeLine(f)}</button></li>)}
            </ul>
          )}
          {query.trim().length >= 2 && !found.length && <p class="small">No place of that name. Towns of 1,000 people and more are known.</p>}
          <div class="row">
            {mapOn() && <button class="btn secondary small" aria-pressed={picking} onClick={() => setPicking((v) => !v)}><Icon name="map" />Pick on the map</button>}
            {gps && <button class="btn secondary small warn" onClick={() => place(null)}>Remove place</button>}
          </div>
          {picking && <PickMap lat={gps?.lat} lon={gps?.lon} onPick={(lat, lon) => place({ lat, lon })} />}
        </div>
        {err && <p class="error" role="alert">{err}</p>}
        <div class="row edactions">
          <button class="btn" onClick={save} disabled={!changed || busy} aria-busy={busy}>{busy ? "Saving…" : "Save"}</button>
          <button class="btn secondary" onClick={p.onClose} disabled={busy}>Cancel</button>
        </div>
        {(isEdited(meta) || touched.revert) && (
          <button class="link edrevert" onClick={revert} disabled={busy || touched.revert}>{touched.revert ? "Reverted: save to keep it" : "Revert to original"}</button>
        )}
        <p class="small">The original stays as it was. The changes are encrypted on this device like the rest of the photo's details.</p>
      </aside>
    </dialog>
  );
}
