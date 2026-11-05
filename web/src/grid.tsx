import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { memo } from "preact/compat";
import type { Item } from "./items";
import { cachedThumb, dropImage, thumbUrl, wantImage } from "./cache";
import { Icon } from "./icons";

export interface Mods { range: boolean; multi: boolean }

export const DRAG_TYPE = "application/x-cipherfilm-items";

const GAP = 4;
const HEAD = 44;

export const dayOf = (it: Item): number => it.meta?.capture_ts ?? it.created_at * 1000;
export const fmtDay = (ts: number): string => new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(ts);
const dayKey = (ts: number): string => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

type Row = { top: number; h: number } & ({ head: string; year: number } | { items: { it: Item; w: number }[] });

const aspect = (it: Item): number => (it.broken ? 1 : it.meta?.width && it.meta?.height ? Math.min(4, Math.max(0.4, it.meta.width / it.meta.height)) : 4 / 3);

export function Tile(p: { item: Item; selectMode: boolean; selected: boolean; onOpen: (m: Mods) => void; onToggle: (m: Mods) => void; dragIds?: () => string[]; w?: number; onContext?: (e: MouseEvent) => void; plain?: boolean }) {
  const it = p.item;
  const [url, setUrl] = useState<string | undefined>(() => cachedThumb(it.id));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (url || !it.has_thumb || it.broken) return;
    let alive = true;
    wantImage("thumb", it.id);
    thumbUrl(it).then((u) => alive && setUrl(u), (e) => alive && e?.message !== "cancelled" && setFailed(true));
    return () => { alive = false; dropImage("thumb", it.id); };
  }, [it.id]);
  const name = it.meta?.name ?? "Unreadable item";
  if (p.plain) {
    // a cover inside another control: no button of its own
    return (
      <span class="tile" aria-hidden="true">
        {url ? <img src={url} alt="" draggable={false} /> : <span class="ph"><Icon name={it.kind === "video" ? "video" : "photos"} size={28} /></span>}
      </span>
    );
  }
  return (
    <button class={"tile" + (p.selected ? " on" : "")} data-id={it.id} style={p.w ? { width: p.w + "px" } : undefined} onClick={(e) => { const m = { range: e.shiftKey, multi: e.metaKey || e.ctrlKey }; (p.selectMode || m.range || m.multi ? p.onToggle : p.onOpen)(m); }}
      onContextMenu={(e) => { if (p.onContext) { e.preventDefault(); p.onContext(e); } }}
      draggable={!!p.dragIds && !it.broken}
      onDragStart={(e) => {
        if (!p.dragIds || !e.dataTransfer) return;
        const ids = p.dragIds();
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
        e.dataTransfer.effectAllowed = "copyMove";
        const g = document.createElement("div");
        g.className = "dragghost";
        g.textContent = ids.length === 1 ? "1 item" : `${ids.length} items`;
        document.body.appendChild(g);
        e.dataTransfer.setDragImage(g, 12, 12);
        setTimeout(() => g.remove(), 0);
      }}
      aria-label={(p.selectMode ? name : `Open ${name}`) + (it.broken || failed ? ": couldn't be verified" : !url && !it.has_thumb ? (it.kind === "video" ? ", video" : ", no preview") : "") + (it.favorite ? ", favorite" : "")} aria-pressed={p.selectMode ? p.selected : undefined}>
      {it.broken || failed ? (
        <span class="ph bad"><span>Couldn't be verified</span></span>
      ) : url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <span class="ph" aria-hidden="true">
          {!it.has_thumb && <Icon name={it.kind === "video" ? "video" : "photos"} size={28} />}
          {!it.has_thumb && <span>{it.kind === "video" ? "Video" : "No preview"}</span>}
        </span>
      )}
      {it.kind === "video" && url && <span class="badge" aria-hidden="true"><Icon name="video" size={14} /></span>}
      {it.favorite && <span class="badge fav" aria-hidden="true"><Icon name="heart" size={14} filled /></span>}
      {p.selectMode && <span class="check-dot" aria-hidden="true">{p.selected && <Icon name="check" size={16} />}</span>}
    </button>
  );
}

/** Timeline by capture day: rows keep every photo's own proportions (justified layout), windowed so only rows near the viewport are in the DOM. */
type Acts = { open: (id: string, m: Mods) => void; toggle: (id: string, m: Mods) => void; context: (id: string, e: MouseEvent) => void; drag: (id: string) => string[] };

/** A tile in the timeline that renders again only when what it shows changes: not on every upload progress tick or
 *  selection elsewhere. Its handlers go through `acts`, which always calls the Timeline's latest ones. */
const RowTile = memo((q: { it: Item; w: number; selectMode: boolean; selected: boolean; acts: Acts; ctx: boolean; drag: boolean }) => (
  <Tile w={q.w} item={q.it} selectMode={q.selectMode} selected={q.selected} onOpen={(m) => q.acts.open(q.it.id, m)} onToggle={(m) => q.acts.toggle(q.it.id, m)}
    onContext={q.ctx ? (e) => q.acts.context(q.it.id, e) : undefined} dragIds={q.drag ? () => q.acts.drag(q.it.id) : undefined} />
));

export function Timeline(p: { items: Item[]; flat?: boolean; selectMode: boolean; selected: Set<string>; onOpen: (id: string, m: Mods) => void; onToggle: (id: string, m: Mods) => void; dragIds?: (id: string) => string[]; onContext?: (id: string, e: MouseEvent) => void }) {
  const live = useRef(p);
  live.current = p;
  const acts = useMemo<Acts>(() => ({
    open: (id, m) => live.current.onOpen(id, m), toggle: (id, m) => live.current.onToggle(id, m),
    context: (id, e) => live.current.onContext?.(id, e), drag: (id) => live.current.dragIds?.(id) ?? [id],
  }), []);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState({ top: 0, h: typeof innerHeight === "number" ? innerHeight : 800 });

  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => {
      setWidth(el.clientWidth);
      const top = window.scrollY - (el.getBoundingClientRect().top + window.scrollY);
      // re-render only when the window moved enough to matter, not on every scroll frame
      setView((v) => (v.h === window.innerHeight && Math.abs(v.top - top) < 120 ? v : { top, h: window.innerHeight }));
    };
    measure();
    let raf = 0;
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); };
  }, []);

  const target = width < 520 ? 120 : width < 900 ? 170 : 210;

  const { rows, total, years } = useMemo(() => {
    const rows: Row[] = [];
    const years: { year: number; top: number }[] = [];
    let top = 0;
    let curKey = "";
    let bucket: Item[] = [];
    const flush = () => {
      let row: { it: Item; ar: number }[] = [];
      let sum = 0;
      let fullH = 0; // height of the last full row: a short last row of the day takes it, so it isn't bigger than the rows above
      const push = (h: number, scale: boolean) => {
        const avail = Math.max(1, width - GAP * (row.length - 1));
        const k = scale ? avail / (sum * h) : 1;
        if (scale) fullH = h * k;
        rows.push({ top, h: h * k + GAP, items: row.map((r) => ({ it: r.it, w: r.ar * h * k })) });
        top += h * k + GAP;
        row = [];
        sum = 0;
      };
      for (const it of bucket) {
        const ar = aspect(it);
        row.push({ it, ar });
        sum += ar;
        if (sum * target + GAP * (row.length - 1) >= width) push(target, true);
      }
      if (row.length) push(fullH ? Math.min(target, fullH) : target, false);
      bucket = [];
    };
    for (const it of p.items) {
      const k = p.flat ? "" : dayKey(dayOf(it)); // flat: search results in their ranked order, no day headings
      if (k !== curKey) {
        flush();
        curKey = k;
        const y = new Date(dayOf(it)).getFullYear();
        if (!years.length || years[years.length - 1].year !== y) years.push({ year: y, top });
        rows.push({ top, h: HEAD, head: fmtDay(dayOf(it)), year: y });
        top += HEAD;
      }
      bucket.push(it);
    }
    flush();
    return { rows, total: top, years };
  }, [p.items, p.flat, width, target]);

  const from = view.top - view.h, to = view.top + view.h * 2;
  const visible = rows.filter((r) => r.top + r.h >= from && r.top <= to);
  const currentYear = [...years].reverse().find((y) => y.top <= view.top + 80)?.year ?? years[0]?.year;
  const jump = (top: number) => window.scrollTo({ top: box.current!.getBoundingClientRect().top + window.scrollY + top - 8, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });

  return (
    <>
      <div class={"timeline" + (years.length > 1 ? " hasscrub" : "")} ref={box} style={{ height: total + "px" }}>
        {visible.map((r) =>
          "head" in r ? (
            <h2 class="dayhead" key={"h" + r.top} style={{ top: r.top + "px", height: r.h + "px" }}>{r.head}</h2>
          ) : (
            <div class="trow" key={r.items[0].it.id} style={{ top: r.top + "px", height: (r.h - GAP) + "px" }}>
              {r.items.map(({ it, w }) => (
                <RowTile key={it.id} w={w} it={it} selectMode={p.selectMode} selected={p.selected.has(it.id)} acts={acts} ctx={!!p.onContext} drag={!!p.dragIds} />
              ))}
            </div>
          ),
        )}
      </div>
      {years.length > 1 && (
        <nav class="scrubber" aria-label="Jump to year">
          {years.map((y) => <button key={y.year} aria-current={y.year === currentYear ? "true" : undefined} onClick={() => jump(y.top)}>{y.year}</button>)}
        </nav>
      )}
    </>
  );
}
