import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Cancelled, discardUpload, forgetUnfinished, Item, SignedOut, loadItems, loadTrash, purgeTrash, restoreItems, setFavorite, trashItems, unfinishedUploads, uploadFile } from "./items";
import { ApiError } from "./api";
import { mem } from "./state";
import { uploadQueue } from "./upqueue";
import { haystack, matches, splitQuery } from "./search";
import { contentSearch, vectorCount } from "./search/content";
import { TEXT_MODELS } from "./search/rank";
import { downloadItems, downloadOriginal } from "./downloads";
import { prefetchThumbs } from "./cache";
import { Album, addToAlbum, createAlbum, deleteAlbum, loadAlbums, removeFromAlbum, renameAlbum } from "./albums";
import { DRAG_TYPE, Mods, Timeline, Tile } from "./grid";
import { ContextMenu, MenuItem } from "./ctxmenu";
import { ShortcutsHelp } from "./shortcuts";
import { Field, KeepButton, Submit, fmtGB, useAction } from "./components";
import { Icon, IconName, Logo } from "./icons";
import { loadUsage } from "./auth";
import { hasIndex, searchFamily, usePeople } from "./people/people";
import { lazy } from "./lazy";

// Loaded when first shown; the lightbox is fetched ahead once the grid is up, so the first photo opens at once.
const Lightbox = lazy(() => import("./lightbox").then((m) => m.Lightbox), () => <div class="lightbox lbwait"><p class="lbmsg" role="status">Loading…</p></div>);
const PeopleList = lazy(() => import("./people/ui").then((m) => m.PeopleList));
const PersonHeader = lazy(() => import("./people/ui").then((m) => m.PersonHeader), () => null);
const Account = lazy(() => import("./screens").then((m) => m.Account));
const Admin = lazy(() => import("./screens").then((m) => m.Admin));

interface Job { key: number; owner: string; name: string; file: File; done: number; total: number; state: "queued" | "working" | "done" | "error"; error?: string; retryable?: boolean; stop: { cancelled: boolean } }
type View = { n: "timeline" } | { n: "favorites" } | { n: "albums" } | { n: "album"; id: string } | { n: "people" } | { n: "person"; key: string; cover?: string } | { n: "trash" };
type Page = View | { n: "account" } | { n: "admin" };

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const isMedia = (f: File) => f.type.startsWith("image/") || f.type.startsWith("video/") || /\.(heic|heif)$/i.test(f.name);
const readDragIds = (e: DragEvent): string[] => {
  try {
    const v: unknown = JSON.parse(e.dataTransfer?.getData(DRAG_TYPE) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{32}$/.test(x)) : [];
  } catch { return []; }
};

function NavItem(p: { icon: IconName; label: string; current: boolean; onClick: () => void; badge?: number }) {
  return (
    <button class="navitem" aria-current={p.current ? "page" : undefined} onClick={p.onClick}>
      <Icon name={p.icon} size={22} />
      <span class="navlabel">{p.label}{p.badge ? ` (${p.badge})` : ""}</span>
    </button>
  );
}

export function Library(props: { email: string; admin: boolean; onSignOut: () => void; onLock: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [page, setPage] = useState<Page>({ n: "timeline" });
  const view = page as View;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState(false);
  const [lb, setLb] = useState<number | null>(null);
  const [trash, setTrash] = useState<Item[] | null>(null);
  const [retention, setRetention] = useState(30);
  const [confirmPurge, setConfirmPurge] = useState<"selected" | "all" | null>(null);
  const [note, setNote] = useState<{ text: string; undo?: () => void } | null>(null);
  const [query, setQuery] = useState("");
  const [showBroken, setShowBroken] = useState(false);
  const [announce, setAnnounce] = useState("");
  const avatarBtn = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [adminSection, setAdminSection] = useState<"users" | "defaults" | "server" | "activity">("users");
  const [ctx, setCtx] = useState<{ x: number; y: number; kind: "item" | "album"; id: string } | null>(null);
  const [help, setHelp] = useState(false);
  const lastSel = useRef<string | null>(null);
  const gPending = useRef(0);
  const [fileDrag, setFileDrag] = useState(false);
  const [tileDrag, setTileDrag] = useState(false);
  const [usage, setUsage] = useState<{ used_bytes: number; quota_bytes: number; unlimited: boolean } | null>(null);
  const lastRefresh = useRef(0);
  const nextKey = useRef(1);
  const input = useRef<HTMLInputElement>(null);
  // the full search hint doesn't fit on a phone and would be cut mid-word
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 600px)").matches);
  useEffect(() => { const m = matchMedia("(max-width: 600px)"); const f = () => setNarrow(m.matches); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, []);

  const refreshItems = () => loadItems().then((r) => { setItems(r.items); setError(""); prefetchThumbs(r.items); }, (e) => setError(msg(e)));
  const refreshAlbums = () => loadAlbums().then(setAlbums, (e) => setError(msg(e)));
  const refreshTrash = () => loadTrash().then((r) => { setTrash(r.items); setRetention(r.retentionDays); }, (e) => setError(msg(e)));
  const refreshUsage = () => loadUsage().then(setUsage, () => {});
  useEffect(() => { refreshItems(); refreshAlbums(); refreshTrash(); refreshUsage(); }, []);
  // once the grid has its first thumbnails, the lightbox's code comes ahead of the first click
  useEffect(() => { if (items) { const t = setTimeout(() => Lightbox.preload().catch(() => {}), 1500); return () => clearTimeout(t); } }, [!!items]);

  // browser back closes the lightbox
  useEffect(() => {
    const onPop = () => setLb(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const openLb = (i: number) => { history.pushState({ cfLb: true }, ""); setLb(i); };
  const closeLb = () => { if (history.state?.cfLb) history.back(); else setLb(null); };

  const album = view.n === "album" ? albums.find((a) => a.id === view.id) : undefined;
  // the people the Android and Mac apps found in the library (not the trash): grouped in a worker, kept current
  const live = useMemo(() => new Set((items ?? []).filter((i) => !i.broken).map((i) => i.id)), [items]);
  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const people = usePeople(live);
  // an unnamed group's key can change when the faces are grouped again: then it is found by its cover face
  const person = view.n === "person" ? people.all.find((g) => g.key === view.key) ?? people.all.find((g) => !!view.cover && g.faces.includes(view.cover)) : undefined;
  const shown = useMemo(() => {
    if (view.n === "trash") return trash ?? [];
    if (!items) return [];
    if (view.n === "favorites") return items.filter((i) => i.favorite);
    if (view.n === "person") { const ids = new Set(person?.items ?? []); return items.filter((i) => ids.has(i.id)); }
    if (!album) return items;
    const ids = new Set(album.itemIds);
    return items.filter((i) => ids.has(i.id));
  }, [items, album, person, trash, view.n]);

  const patch = (key: number, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));
  // Several files at once: a single stream is limited by round trips, not by bandwidth or CPU.
  const FILES_IN_FLIGHT = 3;
  const runJob = async (j: Job) => {
    if (mem.me?.user.id !== j.owner) { patch(j.key, { state: "error", error: new SignedOut().message, retryable: false }); return; }
    patch(j.key, { state: "working", error: undefined });
    try {
      // progress at most 4 times a second: each update renders the upload list
      let shown = 0;
      await uploadFile(j.file, (done, total) => { const now = Date.now(); if (now - shown >= 250 || done >= total) { shown = now; patch(j.key, { done, total }); } }, j.stop);
      patch(j.key, { state: "done", done: j.file.size, total: j.file.size });
      // reloading the whole list after every file would grow quadratically on a big import: at most every 5 seconds
      if (Date.now() - lastRefresh.current > 5000) { lastRefresh.current = Date.now(); await refreshItems(); refreshUsage(); }
    } catch (e) {
      if (e instanceof Cancelled) { discardUpload(j.file, j.owner); return; }
      // a network failure (or the phone pausing the page) is worth retrying by itself; a full quota is not
      const retryable = !(e instanceof SignedOut) && (!(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.status === 408 || e.status === 429);
      patch(j.key, { state: "error", error: msg(e), retryable });
    }
  };
  // bound to the account signed in when the library opened; closed when it leaves the screen (sign-out, lock), so a
  // file still waiting never starts under the next session in this tab
  const queue = useRef<ReturnType<typeof uploadQueue<Job>> | null>(null);
  queue.current ??= uploadQueue<Job>(mem.me!.user.id, FILES_IN_FLIGHT, runJob, async () => { lastRefresh.current = Date.now(); await refreshItems(); refreshUsage(); });
  useEffect(() => () => queue.current!.close(), []);
  const pump = (list: Job[]) => queue.current!.push(list);
  /** Stops a file (at its next part), throws away what it sent, and drops it from the list. */
  const cancel = (keys: number[]) => {
    const drop = new Set(keys);
    for (const j of jobsRef.current) if (drop.has(j.key)) { j.stop.cancelled = true; if (j.state === "error") discardUpload(j.file, j.owner); }
    setJobs((js) => js.filter((j) => !drop.has(j.key)));
  };
  const add = (files: FileList | File[]) => {
    const fresh: Job[] = Array.from(files).map((file) => ({ key: nextKey.current++, owner: mem.me!.user.id, name: file.name, file, done: 0, total: file.size || 1, state: "queued", stop: { cancelled: false } }));
    setJobs((js) => [...js, ...fresh]);
    pump(fresh);
  };

  const toggleOne = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // click toggles in select mode; shift-click selects a range; ctrl/cmd-click adds one and starts select mode
  const pick = (id: string, m?: Mods) => {
    const list = listed().map((i) => i.id);
    setSelectMode(true);
    if (m?.range && lastSel.current && list.includes(lastSel.current) && list.includes(id)) {
      const a = list.indexOf(lastSel.current), b = list.indexOf(id);
      setSelected((s) => { const n = new Set(s); for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) n.add(x); return n; });
    } else toggleOne(id);
    lastSel.current = id;
  };
  const endSelect = () => { setSelectMode(false); setSelected(new Set()); setPicker(false); setConfirmPurge(null); };
  const go = (v: Page) => { endSelect(); setPage(v); requestAnimationFrame(() => document.querySelector<HTMLElement>(".pagetitle")?.focus()); };
  const openPerson = (key: string) => { const g = people.all.find((x) => x.key === key); go({ n: "person", key, cover: g?.cover?.key }); };

  const pickedItems = () => shown.filter((i) => selected.has(i.id));
  const guard = async (fn: () => Promise<void>) => { setError(""); setNote(null); try { await fn(); } catch (e) { setError(msg(e)); } };
  const moveToTrash = (ids: string[]) => guard(async () => { await trashItems(ids); await Promise.all([refreshItems(), refreshAlbums(), refreshTrash()]); endSelect(); setNote({ text: `${ids.length} moved to the trash. You can restore ${ids.length === 1 ? "it" : "them"} for ${retention} days.`, undo: () => { restore(ids); } }); });
  const restore = (ids: string[]) => guard(async () => { await restoreItems(ids); await Promise.all([refreshItems(), refreshAlbums(), refreshTrash()]); endSelect(); setNote({ text: `${ids.length} restored.` }); });
  const purge = (ids: string[]) => guard(async () => { await purgeTrash(ids); await refreshTrash(); await refreshItems(); refreshUsage(); endSelect(); setConfirmPurge(null); });
  /** Marks or unmarks as favorites; on screen at once, put back if the server says no. */
  const favorite = (ids: string[], on: boolean) => {
    const set = new Set(ids);
    const mark = (v: boolean) => setItems((xs) => xs && xs.map((i) => (set.has(i.id) ? { ...i, favorite: v } : i)));
    mark(on);
    setFavorite(ids, on).then(() => setNote({ text: on ? (ids.length === 1 ? "Added to favorites." : `${ids.length} added to favorites.`) : (ids.length === 1 ? "Removed from favorites." : `${ids.length} removed from favorites.`) }), (e) => { mark(!on); setError(msg(e)); });
  };
  const zip = (list: Item[], name: string) => guard(async () => { await downloadItems(list, name); setNote({ text: "Your download is starting. It will appear in your browser's downloads." }); });

  const addIdsToAlbum = async (a: Album, ids: string[]) => {
    if (!ids.length) return;
    try { await addToAlbum(a.id, ids); await refreshAlbums(); endSelect(); setNote({ text: `Added ${ids.length} to “${a.name}”.` }); } catch (e) { setError(msg(e)); }
  };
  const addSelected = (a: Album) => addIdsToAlbum(a, [...selected]);
  const removeIds = async (al: Album, ids: string[]) => {
    try { for (const id of ids) await removeFromAlbum(al.id, id); await refreshAlbums(); endSelect(); } catch (e) { setError(msg(e)); }
  };
  const removeSelected = () => { if (album) removeIds(album, [...selected]); };
  const dragIds = (id: string) => (selectMode && selected.has(id) ? [...selected] : [id]);

  // Drag and drop: files from the desktop upload; tiles dragged onto an album (or the trash) file them there.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const over = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setFileDrag(true); } };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setFileDrag(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setFileDrag(false);
      const files = Array.from(e.dataTransfer!.files).filter(isMedia);
      if (files.length) add(files);
    };
    const start = (e: DragEvent) => { if ((e.target as Element | null)?.closest?.(".tile")) setTileDrag(true); };
    const end = () => setTileDrag(false);
    window.addEventListener("dragenter", over);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragenter", over); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop); window.removeEventListener("dragstart", start); window.removeEventListener("dragend", end);
    };
  }, []);
  const dropTarget = (act: (ids: string[]) => void) => ({
    onDragOver: (e: DragEvent) => { if (e.dataTransfer?.types.includes(DRAG_TYPE)) { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).classList.add("over"); } },
    onDragLeave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("over"),
    onDrop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).classList.remove("over"); setTileDrag(false); act(readDragIds(e)); },
  });

  const active = jobs.filter((j) => j.state !== "done");
  const uploading = active.some((j) => j.state === "working" || j.state === "queued");

  // Phones stop a page that goes to the background or a screen that turns off, and with it the upload. While
  // files upload: keep the screen on, ask before the tab is closed, and pick stopped files up again when the
  // page comes back (finished parts are skipped, so this is cheap).
  useEffect(() => {
    if (!uploading) return;
    let lock: { release: () => Promise<void> } | null = null;
    const wake = async () => {
      try { if (document.visibilityState === "visible" && "wakeLock" in navigator) lock = await (navigator as any).wakeLock.request("screen"); } catch { /* refused or unsupported */ }
    };
    const leave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const back = () => { if (document.visibilityState === "visible") wake(); };
    wake();
    window.addEventListener("beforeunload", leave);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("beforeunload", leave);
      document.removeEventListener("visibilitychange", back);
      lock?.release().catch(() => {});
    };
  }, [uploading]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      const stopped = jobsRef.current.filter((j) => j.state === "error" && j.retryable);
      for (const j of stopped) patch(j.key, { state: "queued", error: undefined });
      if (stopped.length) pump(stopped);
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    // the server can be gone while the network is fine (a restart, an update): no event says it is back, so look again
    const again = setInterval(resume, 15000);
    return () => { document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); clearInterval(again); };
  }, []);
  const [unfinished, setUnfinished] = useState<string[]>(() => unfinishedUploads());
  useEffect(() => { if (!uploading) setUnfinished(unfinishedUploads().filter((n) => !active.some((j) => j.name === n))); }, [uploading]);
  const empty = items && items.length === 0 && active.length === 0;
  const libraryView = page.n === "timeline" || page.n === "favorites" || page.n === "albums" || page.n === "album" || page.n === "people" || page.n === "person" || page.n === "trash";
  const title = page.n === "timeline" ? "Timeline" : page.n === "favorites" ? "Favorites" : page.n === "albums" ? "Albums" : page.n === "trash" ? "Trash" : page.n === "people" ? "People" : page.n === "person" ? person?.person?.name || "Not named yet" : page.n === "account" ? "Account" : page.n === "admin" ? { users: "Users", defaults: "Defaults", server: "Server", activity: "Activity" }[adminSection] : album?.name ?? "Album";
  const pct = usage && !usage.unlimited && usage.quota_bytes ? Math.min(100, Math.round((usage.used_bytes / usage.quota_bytes) * 100)) : 0;

  // the library is filtered 150 ms after typing stops, not on every key: matching a big library takes a moment.
  // Clearing the box shows everything again at once.
  const [searched, setSearched] = useState("");
  useEffect(() => {
    if (!query.trim()) { setSearched(query); return; }
    const t = setTimeout(() => setSearched(query), 150);
    return () => clearTimeout(t);
  }, [query]);
  const q = searched.trim().toLowerCase();
  // what each item can be found by (name, date, camera, type, its albums, the people in it), rebuilt only when the library changes
  const personNames = useMemo(() => people.all.flatMap((g) => (g.person?.name && !g.person.hidden ? [g.person.name] : [])), [people.all]);
  const hay = useMemo(() => {
    const extra = new Map<string, string[]>();
    const add = (id: string, n: string) => extra.set(id, [...(extra.get(id) ?? []), n]);
    for (const a of albums) for (const id of a.itemIds) add(id, a.name);
    for (const g of people.all) if (g.person?.name && !g.person.hidden) for (const id of g.items) add(id, g.person.name);
    const out = new Map<string, string>();
    for (const it of [...(items ?? []), ...(trash ?? [])]) out.set(it.id, haystack(it, extra.get(it.id)));
    return out;
  }, [items, trash, albums, people.all]);

  // what is in the photos: the words that aren't a date, a kind or a name go to the text model (search/content.ts),
  // over the image vectors the Android and Mac apps stored; asked a moment after typing stops
  const split = useMemo(() => splitQuery(q, personNames), [q, personNames]);
  const [content, setContent] = useState<{ q: string; ids: string[] | null; status: string }>({ q: "", ids: null, status: "" });
  const family = searchFamily();
  const searchable = items ? vectorCount(family) : 0;
  useEffect(() => {
    const cq = split.content;
    if (cq.length < 2 || !searchable) { setContent({ q: cq, ids: null, status: "" }); return; }
    let alive = true;
    const size = TEXT_MODELS[family].size;
    const t = setTimeout(() => {
      setContent((c) => ({ ...c, q: cq, status: "Looking at what's in your photos…" }));
      contentSearch(cq, family, (done, total) => {
        if (alive && done < total) setContent((c) => ({ ...c, status: `Getting the search model, once: ${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB…` }));
      }).then((hits) => alive && setContent({ q: cq, ids: hits.map((h) => h.id), status: "" }),
        (e) => alive && setContent({ q: cq, ids: null, status: `Searching what's in photos didn't work: ${e instanceof Error ? e.message : "try again."}` }));
    }, size > 1e8 ? 400 : 250);
    return () => { alive = false; clearTimeout(t); };
  }, [split.content, family, searchable > 0]);
  // ranked like Immich (docs/SEARCH.md): every photo the model indexed, best match first, page by page
  const ranked = content.q === split.content && split.content ? content.ids : null;
  const PAGE = 200;
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [split.content]);

  const match = (list: Item[], withContent = true): Item[] => {
    const visible = view.n === "trash" || showBroken ? list : list.filter((i) => !i.broken);
    if (!q) return visible;
    // what the words name (file, date, camera, album, person) first, then what the photos show, the other words narrowing
    const named = visible.filter((i) => matches(hay.get(i.id) ?? "", q));
    if (!ranked || !withContent) return named;
    const byId = new Map(visible.map((i) => [i.id, i]));
    const seen = new Set(named.map((i) => i.id));
    const out = [...named];
    for (const id of ranked) {
      const it = byId.get(id);
      if (it && !seen.has(id) && split.filters.every((w) => (hay.get(id) ?? "").includes(w))) out.push(it);
    }
    return out;
  };
  const timelineAll = useMemo(() => match(items ?? []), [items, q, showBroken, hay, ranked]);
  const shownAll = useMemo(() => match(shown), [shown, q, showBroken, hay, ranked]);
  const timelineItems = useMemo(() => (ranked ? timelineAll.slice(0, limit) : timelineAll), [timelineAll, ranked, limit]);
  const shownItems = useMemo(() => (ranked ? shownAll.slice(0, limit) : shownAll), [shownAll, ranked, limit]);
  const trashItemsShown = useMemo(() => match(trash ?? [], false), [trash, q]);
  const moreLeft = !!ranked && (view.n === "timeline" ? timelineAll : shownAll).length > limit;
  const lbList = view.n === "timeline" ? timelineItems : view.n === "trash" ? trashItemsShown : shownItems;
  /** The photos on screen, in order: what select all, a range and the selection work on. */
  function listed() { return view.n === "trash" ? trashItemsShown : view.n === "album" || view.n === "person" || view.n === "favorites" ? shownItems : view.n === "timeline" ? timelineItems : []; }
  const selectAll = () => { setSelectMode(true); setSelected(new Set(listed().map((i) => i.id))); };

  // what is selected must be what is on screen: narrowing the search or changing the view drops the rest
  const visibleIds = listed().map((i) => i.id).join(",");
  useEffect(() => {
    const vis = new Set(visibleIds ? visibleIds.split(",") : []);
    setSelected((s) => (s.size && [...s].some((id) => !vis.has(id)) ? new Set([...s].filter((id) => vis.has(id))) : s));
    if (!visibleIds && view.n !== "albums" && view.n !== "people") setSelectMode(false); // nothing left to select
  }, [visibleIds]);
  const adminPage = page.n === "admin";

  const menuKeys = (e: KeyboardEvent) => {
    const items = [...document.querySelectorAll<HTMLButtonElement>(".menu .menuitem")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Tab") setMenuOpen(false);
  };
  useEffect(() => { if (menuOpen) requestAnimationFrame(() => document.querySelector<HTMLElement>(".menu .menuitem")?.focus()); }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: Event) => { if (!(e.target as Element | null)?.closest?.(".menuwrap")) setMenuOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenuOpen(false); avatarBtn.current?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [menuOpen]);

  useEffect(() => { document.title = `${title} · Cipherfilm`; }, [title]);
  useEffect(() => { setAnnounce(selectMode ? `Select mode on. ${selected.size} selected.` : ""); }, [selectMode, selected.size]);
  useEffect(() => {
    if (!note) return;
    setAnnounce(note.text);
    const t = setTimeout(() => setNote((n) => (n === note ? null : n)), note.undo ? 12000 : 6000);
    return () => clearTimeout(t);
  }, [note]);

  const ctxItems = (): MenuItem[] => {
    if (!ctx) return [];
    if (ctx.kind === "album") {
      const al = albums.find((a) => a.id === ctx.id);
      if (!al) return [];
      const inAlbum = (items ?? []).filter((i) => al.itemIds.includes(i.id));
      return [
        { label: "Open album", icon: "albums", run: () => go({ n: "album", id: al.id }) },
        ...(inAlbum.length ? [{ label: "Download as ZIP", icon: "download", run: () => zip(inAlbum, al.name) } as MenuItem] : []),
      ];
    }
    const ids = selected.has(ctx.id) ? [...selected] : [ctx.id];
    const many = ids.length > 1;
    const lbl = (t: string) => (many ? `${t} (${ids.length})` : t);
    const list = listed();
    const it = list.find((i) => i.id === ctx.id);
    const open: MenuItem[] = many ? [] : [{ label: "Open", icon: "expand", run: () => openLb(list.findIndex((i) => i.id === ctx.id)) }];
    const select: MenuItem = { label: selected.has(ctx.id) ? "Deselect" : "Select", icon: "select", run: () => pick(ctx.id) };
    if (view.n === "trash") {
      return [...open, select,
        { label: lbl("Restore"), icon: "restore", run: () => restore(ids) },
        { label: lbl("Delete forever…"), icon: "trash", danger: true, run: () => { setSelectMode(true); setSelected(new Set(ids)); setConfirmPurge("selected"); } }];
    }
    const albumSub: MenuItem[] = albums.map((a) => ({ label: a.name, icon: "albums", run: () => addIdsToAlbum(a, ids) }));
    return [...open, select,
      ...(albums.length ? [{ label: lbl("Add to album"), icon: "folderPlus", sub: albumSub } as MenuItem] : []),
      (ids.every((id) => byId.get(id)?.favorite)
        ? { label: lbl("Remove from favorites"), icon: "heart", run: () => favorite(ids, false) }
        : { label: lbl("Add to favorites"), icon: "heart", run: () => favorite(ids.filter((id) => !byId.get(id)?.favorite), true) }),
      ...(view.n === "album" && album ? [{ label: lbl("Remove from album"), icon: "x", run: () => removeIds(album, ids) } as MenuItem] : []),
      { label: many ? `Download as ZIP (${ids.length})` : "Download original", icon: "download", run: () => (many ? zip(list.filter((i) => ids.includes(i.id)), "Cipherfilm") : guard(async () => { if (it) await downloadOriginal(it); })) },
      { label: lbl("Move to trash"), icon: "trash", danger: true, run: () => moveToTrash(ids) }];
  };

  // keyboard shortcuts; the handler is swapped each render so it always sees current state
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    if (lb !== null || help || ctx) return; // dialogs and menus handle their own keys
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "a" && libraryView && view.n !== "albums" && view.n !== "people") {
      e.preventDefault();
      selectAll();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (gPending.current && Date.now() - gPending.current < 1500) {
      gPending.current = 0;
      const dest: Record<string, Page> = { t: { n: "timeline" }, f: { n: "favorites" }, a: { n: "albums" }, d: { n: "trash" }, ...(hasIndex() ? { p: { n: "people" } as Page } : {}) };
      const d = dest[k.toLowerCase()];
      if (d) { e.preventDefault(); go(d); if (d.n === "trash") refreshTrash(); return; }
    }
    switch (k) {
      case "?": e.preventDefault(); setHelp(true); break;
      case "/": e.preventDefault(); document.querySelector<HTMLInputElement>(".search input")?.focus(); break;
      case "u": case "U": input.current?.click(); break;
      case "s": case "S": if (libraryView && view.n !== "albums" && view.n !== "people") { selectMode ? endSelect() : setSelectMode(true); } break;
      case "g": case "G": gPending.current = Date.now(); break;
      case "Escape": if (menuOpen) setMenuOpen(false); else if (selectMode) endSelect(); break;
      case "Delete": case "Backspace":
        if (e.repeat) break; // a held key must not trash twice
        if (selectMode && selected.size > 0) { e.preventDefault(); if (view.n === "trash") setConfirmPurge("selected"); else moveToTrash([...selected]); }
        break;
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const picks = (
    <div class="actions">
      {(page.n === "timeline" ? items && items.length > 0 : page.n === "trash" ? trash && trash.length > 0 : (page.n === "album" || page.n === "person" || page.n === "favorites") && shown.length > 0) && !selectMode && (
        <button class="btn secondary" aria-label="Select" onClick={() => setSelectMode(true)}><Icon name="select" /><span class="lbl">Select</span></button>
      )}
      {(page.n === "album" || page.n === "person" || page.n === "favorites") && shownItems.length > 1 && !selectMode && (
        <button class="btn secondary" aria-label="Select all" onClick={selectAll}><Icon name="check" /><span class="lbl">Select all</span></button>
      )}
    </div>
  );

  return (
    <div class="shell">
      <header class="topbar">
        <div class="brandrow"><Logo /><span class="brandname">Cipherfilm</span></div>
        {adminPage ? <div /> : <div class="search">
          <Icon name="search" size={18} />
          <input type="text" aria-label="Search your photos" placeholder={narrow ? "Search" : "Search name, date, camera, album"} autocomplete="off" value={query}
            onInput={(e) => { setQuery((e.target as HTMLInputElement).value); if (!libraryView) go({ n: "timeline" }); }} />
        </div>}
        <div class="topactions">
          {!adminPage && <button class="btn" aria-label="Upload photos and videos" onClick={() => input.current?.click()}><Icon name="upload" /><span class="lbl">Upload</span></button>}
          <input ref={input} class="sr" type="file" multiple accept="image/*,video/*,.heic,.heif" tabIndex={-1} aria-label="Choose photos and videos"
            onChange={(e) => { const t = e.target as HTMLInputElement; if (t.files?.length) add(t.files); t.value = ""; }} />
          <div class="menuwrap">
            <button class="avatarbtn" ref={avatarBtn} aria-label="Account menu" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              <span class="avatar" aria-hidden="true">{props.email.slice(0, 1).toUpperCase()}</span>
            </button>
            {menuOpen && (
              <div class="menu" role="menu" aria-label="Account" onKeyDown={menuKeys}>
                <div class="menuhead"><span class="avatar" aria-hidden="true">{props.email.slice(0, 1).toUpperCase()}</span><span class="email">{props.email}</span></div>
                <button class="menuitem" role="menuitem" onClick={() => { setMenuOpen(false); go({ n: "account" }); }}><Icon name="user" />Account</button>
                {props.admin && <button class="menuitem" role="menuitem" onClick={() => { setMenuOpen(false); go({ n: "admin" }); }}><Icon name="shield" />Admin</button>}
                <button class="menuitem" role="menuitem" onClick={() => { setMenuOpen(false); if (uploading) setError("Files are still uploading. Lock when they're done, or cancel them first."); else props.onLock(); }}><Icon name="lock" />Lock</button>
                <button class="menuitem kbditem" role="menuitem" onClick={() => { setMenuOpen(false); setHelp(true); }}><Icon name="keyboard" />Keyboard shortcuts</button>
                <div class="menusep" />
                <button class="menuitem" role="menuitem" onClick={() => { setMenuOpen(false); props.onSignOut(); }}><Icon name="logout" />Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div class="body">
        <nav class="side" aria-label="Sections">
          {adminPage ? (
            <>
              <div class="sidehead">Administration</div>
              <NavItem icon="users" label="Users" current={adminSection === "users"} onClick={() => setAdminSection("users")} />
              <NavItem icon="cloud" label="Defaults" current={adminSection === "defaults"} onClick={() => setAdminSection("defaults")} />
              <NavItem icon="home" label="Server" current={adminSection === "server"} onClick={() => setAdminSection("server")} />
              <NavItem icon="restore" label="Activity" current={adminSection === "activity"} onClick={() => setAdminSection("activity")} />
              <div class="navsep" />
              <NavItem icon="back" label="Back to library" current={false} onClick={() => go({ n: "timeline" })} />
            </>
          ) : (
            <>
              <NavItem icon="photos" label="Timeline" current={page.n === "timeline"} onClick={() => go({ n: "timeline" })} />
              <NavItem icon="heart" label="Favorites" current={page.n === "favorites"} onClick={() => go({ n: "favorites" })} />
              <NavItem icon="albums" label="Albums" current={page.n === "albums" || page.n === "album"} onClick={() => go({ n: "albums" })} />
              {(hasIndex() || page.n === "people" || page.n === "person") && <NavItem icon="users" label="People" current={page.n === "people" || page.n === "person"} onClick={() => go({ n: "people" })} />}
              <NavItem icon="trash" label="Trash" badge={trash && trash.length > 0 ? trash.length : undefined} current={page.n === "trash"} onClick={() => { go({ n: "trash" }); refreshTrash(); }} />
            </>
          )}
          {usage && (
            <div class="storecard" role="img" aria-label={usage.unlimited ? `${fmtGB(usage.used_bytes)} used` : `${fmtGB(usage.used_bytes)} of ${fmtGB(usage.quota_bytes)} used`}>
              <div class="lockline"><Icon name="lock" size={16} />Private to you</div>
              {!usage.unlimited && <div class="meterbar"><div style={{ width: `${pct}%` }} /></div>}
              <span>{fmtGB(usage.used_bytes)}{usage.unlimited ? " used" : ` of ${fmtGB(usage.quota_bytes)}`}</span>
            </div>
          )}
        </nav>

        <main id="main" tabIndex={-1} class="content">
          <div class="pagehead">
            {page.n === "album" && <button class="iconbtn" onClick={() => go({ n: "albums" })} aria-label="All albums"><Icon name="back" /></button>}
            {page.n === "person" && <button class="iconbtn" onClick={() => go({ n: "people" })} aria-label="All people"><Icon name="back" /></button>}
            <h1 class="pagetitle" tabIndex={-1} dir="auto">{title}</h1>
            {libraryView && picks}
          </div>

          {(error || note) && (
            // fixed under the top bar, so the result of an action (and its Undo) is seen however far down the page is
            <div class="toasts">
              {error && <p class="error toast" role="alert"><span>{error}</span><button class="iconbtn tiny" aria-label="Dismiss" onClick={() => setError("")}><Icon name="x" size={16} /></button></p>}
              {note && <p class="note toast" role="status"><span>{note.text}</span>{note.undo && <button class="link" onClick={() => { const u = note.undo!; setNote(null); u(); }}>Undo</button>}</p>}
            </div>
          )}
          {libraryView && view.n !== "trash" && (items ?? []).some((i) => i.broken) && (() => {
            const n = (items ?? []).filter((i) => i.broken).length;
            return (
              <p class="warning small" role="status">
                {n} {n === 1 ? "item couldn't" : "items couldn't"} be verified{showBroken ? "" : ` and ${n === 1 ? "is" : "are"} hidden`}. Your other photos are fine. <button class="link" onClick={() => setShowBroken((v) => !v)}>{showBroken ? "Hide them" : "Show them"}</button>
                {showBroken && " Open one to move it to the trash and clear it."}
              </p>
            );
          })()}
          {libraryView && !uploading && unfinished.length > 0 && (
            <p class="warning small" role="status">
              {unfinished.length === 1 ? `“${unfinished[0]}” didn't finish uploading.` : `${unfinished.length} files didn't finish uploading: ${unfinished.slice(0, 3).map((n) => `“${n}”`).join(", ")}${unfinished.length > 3 ? " and more" : ""}.`}{" "}
              Choose {unfinished.length === 1 ? "it" : "them"} again within two days and the upload continues where it stopped.{" "}
              <button class="link" onClick={() => input.current?.click()}>Choose files</button>{" · "}
              <button class="link" onClick={() => { forgetUnfinished(); setUnfinished([]); }}>Dismiss</button>
            </p>
          )}

          {page.n === "account" && <Account />}
          {page.n === "admin" && <Admin section={adminSection} />}

          {view.n === "timeline" && (
            <>
              {empty && (
                <section class="panel empty">
                  <span class="emptyicon"><Icon name="photos" size={32} /></span>
                  <h2>Your library is empty</h2>
                  <p>Drag photos and videos here, or add them with the button. They're encrypted in this browser before they leave it, so the server only ever stores scrambled data.</p>
                  <button class="btn" onClick={() => input.current?.click()}><Icon name="upload" />Add photos and videos</button>
                </section>
              )}
              {q && content.status && <p class="small" role="status">{content.status}</p>}
              {q && items && items.length > 0 && timelineItems.length === 0 && !content.status && <p class="small">Nothing matches “{searched.trim()}”. Search looks at file names, dates (2023, March, 14.03.2023), cameras, albums and people{searchable ? ", and at what is in your photos" : ""}.{!searchable && " To find photos by what is in them (dog, beach, birthday), turn on search in the Android or Mac app."}</p>}
              {items && items.length > 0 && albums.length > 0 && !selectMode && !q && <p class="small hint desktoponly">Tip: drag photos onto an album to file them.</p>}
              {timelineItems.length > 0 && <Timeline items={timelineItems} flat={!!ranked} selectMode={selectMode} selected={selected} onToggle={pick} onContext={(id, e) => setCtx({ x: e.clientX, y: e.clientY, kind: "item", id })} dragIds={dragIds} onOpen={(id) => openLb(timelineItems.findIndex((i) => i.id === id))} />}
            </>
          )}

          {view.n === "favorites" && (shown.length === 0 ? (
            <section class="panel empty"><span class="emptyicon"><Icon name="heart" size={32} /></span><h2>No favorites yet</h2><p>Open a photo and press the heart (or F) to keep it here. Favorites you mark on your phone or Mac show up here too.</p></section>
          ) : (
            <>
              {q && shownItems.length === 0 && <p class="small">No favorite matches “{searched.trim()}”.</p>}
              <Timeline items={shownItems} flat={!!ranked} selectMode={selectMode} selected={selected} onToggle={pick} onContext={(id, e) => setCtx({ x: e.clientX, y: e.clientY, kind: "item", id })} dragIds={dragIds} onOpen={(id) => openLb(shownItems.findIndex((i) => i.id === id))} />
            </>
          ))}

          {view.n === "trash" && (
            <>
              <p class="small trashnote">Items in the trash are deleted for good after {retention} days. They still count toward your storage until then.</p>
              {trash && trash.length > 0 && (
                <div class="toolbar">
                  {confirmPurge === "all" ? (
                    <div class="warning" role="alertdialog" aria-label="Empty the trash?">
                      <p><strong>Delete {trash.length === 1 ? "the 1 item" : `all ${trash.length} items`} in the trash forever?</strong> This can't be undone.</p>
                      <div class="row"><button class="btn danger small" onClick={() => purge(trash.map((it) => it.id))}>Empty trash</button><KeepButton label="Keep" onClick={() => setConfirmPurge(null)} /></div>
                    </div>
                  ) : (
                    <button class="btn secondary" onClick={() => setConfirmPurge("all")}><Icon name="trash" />Empty trash…</button>
                  )}
                </div>
              )}
              {trash && trash.length === 0 ? (
                <section class="panel empty"><span class="emptyicon"><Icon name="trash" size={32} /></span><h2>The trash is empty</h2><p>Photos and videos you move to the trash wait here, and can be restored for {retention} days.</p></section>
              ) : (
                trash && <Timeline items={trashItemsShown} selectMode={selectMode} selected={selected} onToggle={pick} onContext={(id, e) => setCtx({ x: e.clientX, y: e.clientY, kind: "item", id })} onOpen={(id) => openLb(trashItemsShown.findIndex((i) => i.id === id))} />
              )}
            </>
          )}

          {view.n === "albums" && <AlbumList onContext={(id, e) => setCtx({ x: e.clientX, y: e.clientY, kind: "album", id })} albums={albums} items={items ?? []} dropTarget={(a) => dropTarget((ids) => addIdsToAlbum(a, ids))} onOpen={(id) => go({ n: "album", id })} onCreated={(a) => { setAlbums((x) => [...x, a]); go({ n: "album", id: a.id }); }} setError={setError} />}

          {view.n === "people" && <PeopleList groups={people.groups} ready={people.ready} error={people.error} byId={byId} onOpen={(key) => openPerson(key)} />}

          {view.n === "person" && !person && (people.ready && people.groups ? <p>This person is no longer in your library. <button class="link" onClick={() => go({ n: "people" })}>Back to people</button></p> : <p class="small" role="status">Loading people…</p>)}
          {view.n === "person" && person && (
            <>
              <PersonHeader key={person.key} group={person} item={person.cover && byId.get(person.cover.item)} onRenamed={(key) => setPage({ n: "person", key })} />
              {shownItems.length > 0 && <Timeline items={shownItems} flat={!!ranked} selectMode={selectMode} selected={selected} onToggle={pick} onContext={(id, e) => setCtx({ x: e.clientX, y: e.clientY, kind: "item", id })} dragIds={dragIds} onOpen={(id) => openLb(shownItems.findIndex((i) => i.id === id))} />}
            </>
          )}

          {view.n === "album" && !album && <p>This album no longer exists. <button class="link" onClick={() => go({ n: "albums" })}>Back to albums</button></p>}
          {view.n === "album" && album && (
            <>
              <AlbumHeader album={album} count={shown.length} onZip={() => zip(shown, album.name)}
                onRename={(n) => setAlbums((x) => x.map((a) => (a.id === album.id ? { ...a, name: n } : a)))}
                onDeleted={() => { setAlbums((x) => x.filter((a) => a.id !== album.id)); go({ n: "albums" }); }} setError={setError} />
              {shown.length === 0 ? (
                <section class="panel empty"><span class="emptyicon"><Icon name="albums" size={32} /></span><h2>This album is empty</h2><p>Open your timeline, choose Select, tick some photos and add them to this album. On a computer you can also drag photos onto an album.</p></section>
              ) : (
                <Timeline items={shownItems} flat={!!ranked} selectMode={selectMode} selected={selected} onToggle={pick} onContext={(id, e) => setCtx({ x: e.clientX, y: e.clientY, kind: "item", id })} dragIds={dragIds} onOpen={(id) => openLb(shownItems.findIndex((i) => i.id === id))} />
              )}
            </>
          )}
          {moreLeft && <MoreResults onMore={() => setLimit((l) => l + PAGE)} />}
        </main>
      </div>

      {tileDrag && libraryView && (
        <div class="droptray" role="region" aria-label="Drop to file these photos">
          <span class="small">Drop on an album</span>
          {albums.filter((a) => !(album && a.id === album.id)).map((a) => <span key={a.id} class="chip" {...dropTarget((ids) => addIdsToAlbum(a, ids))}><Icon name="albums" size={18} />{a.name}</span>)}
          {view.n !== "trash" && <span class="chip danger" {...dropTarget((ids) => { if (ids.length) moveToTrash(ids); })}><Icon name="trash" size={18} />Trash</span>}
        </div>
      )}
      {fileDrag && <div class="dropveil" role="status"><Icon name="upload" size={40} /><strong>Drop to add to your library</strong><span>Photos and videos are encrypted here before they upload.</span></div>}

      {jobs.length > 0 && (
        <UploadPanel jobs={jobs} lifted={selectMode && libraryView}
          retry={(j) => { patch(j.key, { state: "queued" }); pump([j]); }}
          cancel={cancel}
          close={() => setJobs((js) => js.filter((j) => j.state !== "done"))} />
      )}

      {selectMode && libraryView && (
        <div class="selbar" role="region" aria-label="Selection">
          <button class="btn secondary small" aria-label="Done" onClick={endSelect}><Icon name="x" size={18} /><span class="lbl">Done</span><span class="lbls">Done</span></button>
          <span class="selcount" aria-live="polite">{selected.size}<span class="selword"> selected</span></span>
          {listed().length > 1 && !narrow && (selected.size < listed().length
            ? <button class="btn secondary small selall" aria-label="Select all" onClick={selectAll}><Icon name="check" size={18} /><span class="lbl">Select all</span></button>
            : <button class="btn secondary small selall" aria-label="Select none" onClick={() => setSelected(new Set())}><Icon name="x" size={18} /><span class="lbl">Select none</span></button>)}
          {view.n !== "trash" && (() => {
            const picked = pickedItems();
            const allFav = picked.length > 0 && picked.every((i) => i.favorite);
            return <button class="btn secondary small" aria-label="Favorite" aria-pressed={allFav} title={allFav ? "Remove from favorites" : "Add to favorites"} disabled={picked.length === 0}
              onClick={() => favorite(picked.filter((i) => !!i.favorite === allFav).map((i) => i.id), !allFav)}><Icon name="heart" size={18} filled={allFav} /><span class="lbl">Favorite</span><span class="lbls">Favorite</span></button>;
          })()}
          {view.n !== "trash" && <button class="btn small" aria-label="Add to album" disabled={selected.size === 0} onClick={() => setPicker((v) => !v)} aria-expanded={picker}><Icon name="folderPlus" size={18} /><span class="lbl">Add to album</span><span class="lbls">Album</span></button>}
          {view.n === "album" && <button class="btn secondary small" aria-label="Remove from album" disabled={selected.size === 0} onClick={removeSelected}><Icon name="x" size={18} /><span class="lbl">Remove from album</span><span class="lbls">Remove</span></button>}
          {view.n !== "trash" && <button class="btn secondary small" aria-label="Download as ZIP" disabled={selected.size === 0} onClick={() => zip(pickedItems(), "Cipherfilm")}><Icon name="download" size={18} /><span class="lbl">Download</span><span class="lbls">ZIP</span></button>}
          {view.n !== "trash" && <button class="btn secondary small warn" aria-label="Move to trash" disabled={selected.size === 0} onClick={() => moveToTrash([...selected])}><Icon name="trash" size={18} /><span class="lbl">Move to trash</span><span class="lbls">Trash</span></button>}
          {view.n === "trash" && <button class="btn small" aria-label="Restore" disabled={selected.size === 0} onClick={() => restore([...selected])}><Icon name="restore" size={18} /><span class="lbl">Restore</span><span class="lbls">Restore</span></button>}
          {view.n === "trash" && (confirmPurge === "selected" && selected.size > 0 ? (
            <span class="moremenu"><span class="small">Delete {selected.size} forever?</span><button class="btn danger small" onClick={() => purge([...selected])}>Delete forever</button><KeepButton label="Keep" onClick={() => setConfirmPurge(null)} /></span>
          ) : (
            <button class="btn secondary small warn" aria-label="Delete forever…" disabled={selected.size === 0} onClick={() => setConfirmPurge("selected")}><Icon name="trash" size={18} /><span class="lbl">Delete forever…</span><span class="lbls">Delete</span></button>
          ))}
          {picker && (
            <AlbumPicker albums={albums} onPick={addSelected} setError={setError}
              onCreated={async (a) => { setAlbums((x) => [...x, a]); await addSelected(a); }} />
          )}
        </div>
      )}

      {ctx && libraryView && <ContextMenu x={ctx.x} y={ctx.y} title={ctx.kind === "album" ? "Album actions" : "Photo actions"} items={ctxItems()} onClose={() => setCtx(null)} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}

      {lb !== null && libraryView && lbList[lb] && (
        <Lightbox items={lbList} index={lb} onIndex={setLb} onClose={closeLb} people={people} onPerson={(key) => { closeLb(); openPerson(key); }}
          onFavorite={view.n === "trash" ? undefined : (it) => favorite([it.id], !it.favorite)}
          action={view.n === "trash"
            ? { label: "Restore", run: async (it) => { await restore([it.id]); closeLb(); setTimeout(() => document.getElementById("main")?.focus(), 60); } }
            : { label: "Move to trash", run: async (it) => { await moveToTrash([it.id]); closeLb(); setTimeout(() => document.getElementById("main")?.focus(), 60); } }} />
      )}
    </div>
  );
}

/** The end of a page of search results: the next page comes when it scrolls into view (or on the button). */
function MoreResults(p: { onMore: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const more = useRef(p.onMore);
  more.current = p.onMore;
  useEffect(() => {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more.current(); }, { rootMargin: "600px" });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);
  return <button ref={ref} class="btn secondary moreresults" onClick={() => more.current()}>Show more</button>;
}

const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const duration = (sec: number) => (sec < 60 ? "under a minute" : sec < 3600 ? `about ${Math.round(sec / 60)} min` : `about ${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`);
const ROWS = 60; // a big import lists the files that matter now, not thousands of rows

/** Uploads in a corner window, as in other apps: one line with the overall state, the files below, collapsible.
 *  Built for long runs: speed and time left come from the last half minute, and any file can be cancelled. */
function UploadPanel(p: { jobs: Job[]; lifted: boolean; retry: (j: Job) => void; cancel: (keys: number[]) => void; close: () => void }) {
  const [open, setOpen] = useState(true);
  const samples = useRef<{ t: number; b: number }[]>([]);
  const unfinished = p.jobs.filter((j) => j.state !== "done");
  const running = unfinished.filter((j) => j.state !== "error");
  const failed = unfinished.filter((j) => j.state === "error");
  const done = p.jobs.length - unfinished.length;
  const total = p.jobs.reduce((a, j) => a + j.file.size, 0);
  const sent = p.jobs.reduce((a, j) => a + (j.state === "done" ? j.file.size : Math.min(j.done, j.file.size)), 0);

  // bytes per second over the last 30 seconds
  const now = Date.now();
  const sm = samples.current;
  if (!sm.length || sm[sm.length - 1].b !== sent) sm.push({ t: now, b: sent });
  while (sm.length > 2 && now - sm[0].t > 30_000) sm.shift();
  const rate = running.length && sm.length > 1 && now - sm[0].t > 3000 ? (sent - sm[0].b) / ((now - sm[0].t) / 1000) : 0;
  const left = rate > 0 ? (total - sent) / rate : 0;

  // when everything finished cleanly, the window goes away by itself after a moment
  useEffect(() => {
    if (unfinished.length || !done) return;
    const t = setTimeout(p.close, 6000);
    return () => clearTimeout(t);
  }, [unfinished.length, done]);

  const title = running.length
    ? `Uploading ${running.length === 1 ? "1 file" : `${running.length} files`}`
    : failed.length ? `${failed.length === 1 ? "1 upload" : `${failed.length} uploads`} stopped` : `${done === 1 ? "1 file" : `${done} files`} uploaded`;
  const detail = running.length
    ? [`${bytes(sent)} of ${bytes(total)}`, rate > 0 && `${bytes(rate)}/s`, rate > 0 && `${duration(left)} left`].filter(Boolean).join(" · ")
    : done ? "Encrypted on this device, safely in Cipherfilm" : "";
  const pct = total ? Math.round((sent / total) * 100) : 0;
  const rows = [...unfinished.filter((j) => j.state === "working"), ...failed, ...unfinished.filter((j) => j.state === "queued")];

  return (
    <section class={"uploadpanel" + (p.lifted ? " lifted" : "") + (open ? "" : " closed")} aria-label="Uploads">
      <header class="uphead">
        <div class="uptitle">
          <strong>{title}</strong>
          {detail && <span class="small">{detail}</span>}
        </div>
        <button class="iconbtn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={open ? "Collapse uploads" : "Show uploads"}><span class={"upchev" + (open ? "" : " up")}><Icon name="chevdown" size={20} /></span></button>
        {running.length ? (
          <button class="iconbtn" onClick={() => p.cancel(unfinished.map((j) => j.key))} aria-label="Cancel all uploads" title="Cancel all"><Icon name="x" size={20} /></button>
        ) : (
          <button class="iconbtn" onClick={() => (failed.length ? p.cancel(failed.map((j) => j.key)) : p.close())} aria-label="Close" title="Close"><Icon name="x" size={20} /></button>
        )}
      </header>
      {running.length > 0 && (
        <div class="track uptrack" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div class="fill" style={{ width: `${pct}%` }} /></div>
      )}
      {open && unfinished.length > 0 && (
        <ul class="jobs">
          {rows.slice(0, ROWS).map((j) => {
            const jp = Math.round((j.done / j.total) * 100);
            return (
              <li key={j.key}>
                <div class="jobhead">
                  <span class="jobname" dir="auto" title={j.name}>{j.name}</span>
                  <button class="iconbtn tiny" onClick={() => p.cancel([j.key])} aria-label={`Cancel ${j.name}`} title="Cancel"><Icon name="x" size={16} /></button>
                </div>
                <span class="small jobstate">
                  {j.state === "queued" ? `Waiting · ${bytes(j.file.size)}` : j.state === "error" ? "Stopped" : `Encrypting and uploading · ${bytes(Math.min(j.done, j.file.size))} of ${bytes(j.file.size)}`}
                </span>
                {j.state !== "queued" && (
                  <div class="track" role="progressbar" aria-label={`Upload progress for ${j.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={jp}>
                    <div class={"fill" + (j.state === "error" ? " err" : "")} style={{ width: `${jp}%` }} />
                  </div>
                )}
                {j.error && <p class="error" role="alert">{j.error}{j.retryable ? " It continues by itself when the connection is back." : ""} <button class="link" onClick={() => p.retry(j)}>Try again</button></p>}
              </li>
            );
          })}
          {rows.length > ROWS && <li class="jobnote small">and {rows.length - ROWS} more waiting</li>}
          {running.length > 0 && <li class="jobnote small">Keep this page open until the upload finishes. If it stops, it continues where it left off.</li>}
        </ul>
      )}
    </section>
  );
}

function NewAlbumForm(p: { onCreated: (a: Album) => void; setError: (m: string) => void; label?: string }) {
  const [name, setName] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form class="inline" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; run(async () => { p.onCreated(await createAlbum(name)); setName(""); }); }}>
      <Field label="New album name" id={"new-album-" + (p.label ?? "x")} value={name} onInput={setName} autocomplete="off" required={false} />
      {error && <p class="error" role="alert">{error}</p>}
      <Submit busy={busy} label="Create album" busyLabel="Creating…" />
    </form>
  );
}

function AlbumList(p: { onContext: (id: string, e: MouseEvent) => void; albums: Album[]; items: Item[]; dropTarget: (a: Album) => Record<string, unknown>; onOpen: (id: string) => void; onCreated: (a: Album) => void; setError: (m: string) => void }) {
  const byId = useMemo(() => new Map(p.items.map((i) => [i.id, i])), [p.items]);
  return (
    <div>
      {p.albums.length === 0 ? (
        <section class="panel empty"><span class="emptyicon"><Icon name="albums" size={32} /></span><h2>No albums yet</h2><p>Albums are private too: their names are encrypted. A photo can be in as many albums as you like.</p></section>
      ) : (
        <ul class="albums" aria-label="Albums">
          {p.albums.map((a) => {
            const cover = a.itemIds.map((id) => byId.get(id)).find((i) => i && !i.broken);
            return (
              <li key={a.id}>
                <button class="albumcard" onClick={() => p.onOpen(a.id)} onContextMenu={(e) => { e.preventDefault(); p.onContext(a.id, e); }} {...(p.dropTarget(a) as object)}>
                  <span class="cover">{cover ? <Tile plain item={cover} selectMode={false} selected={false} onOpen={() => {}} onToggle={() => {}} /> : <span class="ph" aria-hidden="true" />}</span>
                  <span class="aname" dir="auto">{a.name}</span>
                  <span class="small">{a.itemIds.length} {a.itemIds.length === 1 ? "item" : "items"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <section class="panel"><h2>Create an album</h2><NewAlbumForm onCreated={p.onCreated} setError={p.setError} label="list" /></section>
    </div>
  );
}

function AlbumPicker(p: { albums: Album[]; onPick: (a: Album) => void; onCreated: (a: Album) => void; setError: (m: string) => void }) {
  return (
    <div class="picker">
      {p.albums.length > 0 && (
        <ul class="pickerlist" aria-label="Choose an album">
          {p.albums.map((a) => <li key={a.id}><button class="btn secondary small" onClick={() => p.onPick(a)}>{a.name}</button></li>)}
        </ul>
      )}
      <NewAlbumForm onCreated={p.onCreated} setError={p.setError} label="picker" />
    </div>
  );
}

function AlbumHeader(p: { album: Album; count: number; onZip: () => void; onRename: (n: string) => void; onDeleted: () => void; setError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.album.name);
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <header class="albumhead">
      {editing ? (
        <form class="inline" onSubmit={(e) => { e.preventDefault(); run(async () => { p.onRename(await renameAlbum(p.album.id, name)); setEditing(false); requestAnimationFrame(() => document.querySelector<HTMLElement>(".pagetitle")?.focus()); }); }}>
          <Field label="Album name" id="rename-album" value={name} onInput={setName} autocomplete="off" autofocus />
          {error && <p class="error" role="alert">{error}</p>}
          <div class="row"><Submit busy={busy} label="Save name" busyLabel="Saving…" /><button type="button" class="btn secondary" onClick={() => { setEditing(false); setName(p.album.name); }}>Cancel</button></div>
        </form>
      ) : (
        <>
          <div class="row">
            <button class="btn secondary small" onClick={() => setEditing(true)}><Icon name="edit" size={18} />Rename</button>
            {p.count > 0 && <button class="btn secondary small" onClick={p.onZip}><Icon name="download" size={18} />Download as ZIP</button>}
            <button class="btn secondary small" onClick={() => setConfirm(true)}><Icon name="trash" size={18} />Delete album…</button>
          </div>
        </>
      )}
      {confirm && (
        <div class="warning" role="alertdialog" aria-label="Delete this album?">
          <p><strong>Delete “{p.album.name}”?</strong> The photos and videos stay in your library; only the album goes away.</p>
          <div class="row">
            <button class="btn danger small" onClick={async () => { try { await deleteAlbum(p.album.id); p.onDeleted(); } catch (e) { p.setError(msg(e)); } }}>Delete album</button>
            <KeepButton label="Keep it" onClick={() => setConfirm(false)} />
          </div>
        </div>
      )}
    </header>
  );
}

