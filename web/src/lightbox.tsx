import { Icon } from "./icons";
import { useEffect, useRef, useState } from "preact/hooks";
import { Item, fetchOriginal } from "./items";
import { lazy } from "./lazy";
import { downloadEdited, downloadOriginal } from "./downloads";
import { leavesAs, normEdit, pictureKey } from "./edit/edit";
import { canEdit } from "./edit/apply";
import { BLOB_LIMIT, forgetStream, prepareStream, streamingAvailable } from "./player";
import { playMime } from "./sw-range";
import { cachedPreview, cachedThumb, previewUrl, thumbUrl } from "./cache";
import { dayOf, fmtDay } from "./grid";
import type { Group } from "./people/people";
import { PhotoPeople } from "./people/ui";
import { Loading } from "./loader";

const fmtBytes = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");

function VideoPlayer({ item }: { item: Item }) {
  const [src, setSrc] = useState("");
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("Preparing video…");
  useEffect(() => {
    let alive = true;
    let blobUrl = "";
    setSrc(""); setErr("");
    (async () => {
      try {
        if (await streamingAvailable()) {
          const u = await prepareStream(item);
          if (alive) setSrc(u);
        } else if (item.size <= BLOB_LIMIT) {
          setStatus("Decrypting video…");
          const b = await fetchOriginal(item);
          blobUrl = URL.createObjectURL(new Blob([b], { type: playMime(item.meta?.mime ?? "", item.meta?.name ?? "") }));
          if (alive) setSrc(blobUrl);
        } else if (alive) {
          setErr("This video is too large to play in this browser. Download the original to watch it.");
        }
      } catch {
        if (alive) setErr("This video couldn't be loaded or verified. Try downloading the original.");
      }
    })();
    return () => { alive = false; forgetStream(item.id); if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [item.id]);
  if (err) return <p class="lbmsg">{err}</p>;
  if (!src) return <Loading stage label={status} />;
  return (
    <video key={src} src={src} controls playsInline preload="metadata" poster={cachedThumb(item)} aria-label={item.meta?.name}
      onError={() => setErr("This video can't be played here. This browser may not support its format (videos from phones often use HEVC), or it couldn't be verified. Download the original instead.")} />
  );
}

const Editor = lazy(() => import("./edit/editor").then((m) => m.Editor), () => null);

export function Lightbox(p: { items: Item[]; index: number; onIndex: (i: number) => void; onClose: () => void; action?: { label: string; run: (it: Item) => Promise<void> }; people?: { all: Group[]; ready: boolean }; onPerson?: (key: string) => void; onFavorite?: (it: Item) => void; onMap?: () => void; onEdited?: (id: string) => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const startX = useRef<number | null>(null);
  const it = p.items[p.index];
  const [url, setUrl] = useState<string | undefined>();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(false);
  const [editing, setEditing] = useState(false);
  const editable = !!p.onEdited && canEdit(it);
  const turned = !!normEdit(it.meta?.edit);
  // an edited photo downloads as edited, also one whose date or place changed (a removed place isn't handed out in the
  // file); the original is in the details (and Shift+D)
  const edited = !it.broken && leavesAs(it.kind, it.meta, it.stale) !== "original";
  const download = (original = false) => {
    if (busy) return;
    setBusy(true);
    (edited && !original ? downloadEdited(it) : downloadOriginal(it)).catch((x) => setErr(x instanceof Error ? x.message : "Couldn't download.")).finally(() => setBusy(false));
  };

  // on close, focus goes to the tile of the photo last shown (the one opened may be far away by then), else to the page
  const shownId = useRef(it.id);
  shownId.current = it.id;
  useEffect(() => {
    const d = dlg.current!;
    d.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
      d.close();
      setTimeout(() => {
        const tile = document.querySelector<HTMLElement>(`.tile[data-id="${shownId.current}"]`);
        if (tile) { tile.focus({ preventScroll: true }); tile.scrollIntoView({ block: "nearest" }); } else document.getElementById("main")?.focus();
      });
    };
  }, []);

  useEffect(() => {
    setUrl(cachedPreview(it) ?? cachedThumb(it));
    setErr("");
    let alive = true;
    if (!it.broken && (it.kind === "image" || it.kind === "video")) {
      const load = it.has_preview ? previewUrl(it) : it.has_thumb ? thumbUrl(it) : null;
      load?.then((u) => alive && setUrl(u), () => alive && setErr("This photo couldn't be verified, so it isn't shown."));
    }
    for (const n of [p.items[p.index - 1], p.items[p.index + 1]]) if (n && !n.broken && n.has_preview) previewUrl(n).catch(() => {});
    return () => { alive = false; };
  }, [pictureKey(it.id, it.meta)]); // a new preview after an edit

  const go = (d: number) => { const i = p.index + d; if (i >= 0 && i < p.items.length) p.onIndex(i); };
  const name = it.meta?.name ?? "Unreadable item";
  const m = it.meta;
  const strip = p.items.map((x, i) => ({ x, i })).filter(({ i }) => Math.abs(i - p.index) <= 5);

  return (
    <dialog ref={dlg} class="lightbox" aria-label={`${name}, ${p.index + 1} of ${p.items.length}`}
      onCancel={(e) => { e.preventDefault(); if (info) setInfo(false); else p.onClose(); }}
      onKeyDown={(e) => { if (editing || (e.target as HTMLElement | null)?.closest?.("input, textarea")) return; if (e.key === "ArrowLeft") go(-1); else if (e.key === "ArrowRight") go(1); else if (e.key === "i" && !e.metaKey && !e.ctrlKey) setInfo((v) => !v);
        else if (e.key === "f" && !e.metaKey && !e.ctrlKey && !e.altKey && p.onFavorite && !it.broken) p.onFavorite(it);
        else if ((e.key === "d" || e.key === "D") && !e.ctrlKey && !e.metaKey && !e.altKey && !it.broken) download(e.shiftKey)
        else if (e.key === "e" && !e.ctrlKey && !e.metaKey && !e.altKey && editable) setEditing(true);
        else if ((e.key === "Delete" || e.key === "Backspace") && p.action?.label === "Move to trash" && !busy) { e.preventDefault(); setBusy(true); p.action.run(it).catch((x) => { setErr(x instanceof Error ? x.message : "That didn't work."); setBusy(false); }); } }}>
      <div class="lbtop">
        <button class="lbbtn" onClick={p.onClose} aria-label="Close"><Icon name="back" /></button>
        <div class="lbtitle"><strong class="lbname" dir="auto">{name}</strong><span class="lbcount" aria-live="polite">{p.index + 1} of {p.items.length}</span></div>
        {p.onFavorite && !it.broken && (
          <button class={"lbbtn" + (it.favorite ? " faved" : "")} aria-label="Favorite" aria-pressed={!!it.favorite} title={it.favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => p.onFavorite!(it)}>
            <Icon name="heart" filled={it.favorite} />
          </button>
        )}
        <button class="lbbtn" aria-label="Show info" aria-pressed={info} onClick={() => setInfo((v) => !v)}><Icon name="info" /></button>
        {editable && (
          <button class="lbbtn" aria-label="Edit" title="Edit (E)" onClick={() => setEditing(true)}><Icon name="edit" /></button>
        )}
        {!it.broken && (
          <button class="lbbtn" aria-label={edited ? "Download edited photo" : "Download original"} title={edited ? "Download edited photo (D)" : "Download original (D)"} disabled={busy} onClick={() => download()}>
            <Icon name="download" />
          </button>
        )}
        {p.action && (
          <button class="lbbtn" aria-label={p.action.label} disabled={busy} onClick={async () => { setBusy(true); try { await p.action!.run(it); } catch (e) { setErr(e instanceof Error ? e.message : "That didn't work."); setBusy(false); } }}>
            <Icon name={p.action.label === "Restore" ? "restore" : "trash"} />
          </button>
        )}
      </div>
      <div class="stage"
        onPointerDown={(e) => { if (e.pointerType !== "mouse") startX.current = e.clientX; }}
        onPointerUp={(e) => { if (startX.current === null) return; const dx = e.clientX - startX.current; startX.current = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); }}>
        <button class="nav prev" onClick={() => go(-1)} disabled={p.index === 0} aria-label="Previous"><Icon name="back" size={24} /></button>
        {it.broken || err ? (
          <p class="lbmsg">{err || "This item couldn't be verified, so it isn't shown. Your other photos are fine. You can move it to the trash."}</p>
        ) : it.kind === "video" ? (
          <VideoPlayer key={it.id} item={it} />
        ) : url ? (
          <img src={url} alt={name} draggable={false} />
        ) : it.kind === "image" ? (
          <Loading stage label="Decrypting…" />
        ) : (
          <p class="lbmsg">No preview for this file. Download the original to open it.</p>
        )}
        <button class="nav next" onClick={() => go(1)} disabled={p.index === p.items.length - 1} aria-label="Next"><Icon name="next" size={24} /></button>
      </div>
      <div class="lbbottom">
        <div class="film" role="group" aria-label="Nearby photos">
          {strip.map(({ x, i }) => (
            <button key={x.id} aria-label={`Go to ${x.meta?.name ?? "item"}`} aria-current={i === p.index ? "true" : undefined} onClick={() => p.onIndex(i)}>
              {cachedThumb(x) ? <img src={cachedThumb(x)} alt="" draggable={false} /> : null}
            </button>
          ))}
        </div>
      </div>
      {info && (
        <aside class="infopanel" aria-label="Details">
          <div class="infohead"><h2><Icon name="info" size={18} />Info</h2><button class="lbbtn" aria-label="Close info" onClick={() => setInfo(false)}><Icon name="x" /></button></div>
          <dl>
            <div><dt>Date</dt><dd class="serifdate">{fmtDay(dayOf(it))}{m?.capture_ts ? `, ${new Date(m.capture_ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</dd></div>
            <div><dt>File</dt><dd class="lbfull" dir="auto">{name}</dd></div>
            <div><dt>Size</dt><dd>{fmtBytes(it.size)}{m?.width ? `, ${m.width} × ${m.height}` : ""}{m?.mime ? `, ${m.mime}` : ""}</dd></div>
            {(m?.make || m?.model) && <div><dt>Camera</dt><dd>{[m.make, m.model].filter(Boolean).join(" ")}</dd></div>}
            {m?.gps && <div><dt>Location</dt><dd><PlaceName item={it} />{m.gps.lat.toFixed(4)}, {m.gps.lon.toFixed(4)}</dd></div>}
            {m?.gps && Number.isFinite(m.gps.lat) && Number.isFinite(m.gps.lon) && <MiniMap lat={m.gps.lat} lon={m.gps.lon} onShowMap={p.onMap} />}
            {m?.duration ? <div><dt>Length</dt><dd>{Math.round(m.duration)} s</dd></div> : null}
            {edited && <div><dt>Edited</dt><dd>{turned ? "Turned or cropped." : "Date or place changed."} The original is kept. <button class="link" disabled={busy} onClick={() => download(true)}>Download original</button></dd></div>}
            {p.people && p.onPerson && !it.broken && <PhotoPeople item={it} all={p.people.all} ready={p.people.ready} onPerson={p.onPerson} />}
          </dl>
          <p class="small">Decrypted in your browser. The server never sees these details.</p>
        </aside>
      )}
      {editing && <Editor key={it.id} item={it} onSaved={() => p.onEdited?.(it.id)}
        onClose={() => { setEditing(false); setTimeout(() => dlg.current?.querySelector<HTMLElement>('[aria-label="Edit"]')?.focus()); }} />}
    </dialog>
  );
}

// the base map (MapLibre) loads only when a photo with a location shows its details
const MiniMap = lazy(() => import("./map/ui").then((m) => m.MiniMap), () => null);

/** The town and country of a photo's coordinates, looked up on this device (map/locations.ts). */
function PlaceName({ item }: { item: Item }) {
  const [name, setName] = useState("");
  useEffect(() => {
    let alive = true;
    setName("");
    import("./map/locations").then((m) => m.placeName(item)).then((n) => alive && setName(n), () => {});
    return () => { alive = false; };
  }, [item.id, item.meta?.gps?.lat, item.meta?.gps?.lon]); // also after the place was changed
  return name ? <><span dir="auto">{name}</span><br /></> : null;
}
