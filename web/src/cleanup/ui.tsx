// Duplicates and similar photos (Account menu): found in this browser from the decrypted metadata and the image
// vectors the Android and Mac apps stored (docs/SEARCH.md); the server learns nothing new. What is chosen goes to
// the trash, from where it can be restored for 30 days.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Item } from "../items";
import { Tile } from "../grid";
import { Icon } from "../icons";
import { Loading } from "../loader";
import { fmtGB } from "../components";
import { hasIndex, refreshIndex, searchFamily } from "../people/people";
import { hasVector, scorePairs } from "../search/content";
import { bytesOf, chosenWith, findGroups, type Candidate, type Found, type Group } from "./duplicates";

/** What the grouping needs of an item. Broken items (and the trash, which isn't in the list) are left out. */
export const candidateOf = (it: Item): Candidate | null =>
  it.broken || !it.meta ? null : {
    id: it.id, ts: it.meta.capture_ts, name: it.meta.name, size: it.meta.size || it.size, width: it.meta.width, height: it.meta.height,
    gps: !!it.meta.gps, uploaded: it.created_at, image: it.kind === "image",
  };

const SHOWN = 40; // groups at first; more on request
const fmtSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function Duplicates(p: { items: Item[] | null; demo: boolean; retention: number; onTrash: (ids: string[]) => Promise<void> }) {
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState("");
  // what the person changed, kept when the groups are found again (the library changed meanwhile)
  const [changed, setChanged] = useState<Map<string, boolean>>(new Map());
  const [limit, setLimit] = useState(SHOWN);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map((p.items ?? []).map((i) => [i.id, i])), [p.items]);

  useEffect(() => {
    if (!p.items) return;
    let alive = true;
    const items = p.items;
    (async () => {
      await refreshIndex().catch(() => {}); // what the apps indexed since; without it, only exact duplicates
      const family = searchFamily(); // the explicit model only where the account chose it and an admin allowed it
      const cands = items.flatMap((it) => candidateOf(it) ?? []);
      return findGroups(cands, (id) => hasVector(id, family), hasIndex() ? (a, b) => scorePairs(family, a, b) : null);
    })().then((f) => { if (alive) { setFound(f); setError(""); } },
      (e) => alive && setError(e instanceof Error ? e.message : "Couldn't look for duplicates."));
    return () => { alive = false; };
  }, [p.items]);

  const size = (id: string) => byId.get(id)?.size ?? 0;
  const groups = found ? [...found.exact, ...found.similar] : [];
  const chosen = useMemo(() => chosenWith(groups, changed), [found, changed]);
  const live = [...chosen].filter((id) => byId.has(id));
  const bytes = bytesOf(live, size);
  const toggle = (id: string) => setChanged((m) => new Map(m).set(id, !chosen.has(id)));
  const move = async () => {
    setBusy(true);
    try { await p.onTrash(live); } finally { setBusy(false); }
  };

  if (error) return <p class="error" role="alert">{error}</p>;
  if (!found) return <Loading label="Looking for duplicates and similar photos…" />;
  const missing = found.images - found.indexed;
  return (
    <div class="dupes">
      <section class="panel">
        <h2><Icon name="copy" />{groups.length ? `${groups.length} ${groups.length === 1 ? "group" : "groups"}` : "No duplicates found"}</h2>
        <p class="small">
          {groups.length
            ? `${live.length} chosen to move to the trash, freeing ${fmtGB(bytes)}. The suggested one to keep in each group is marked; click a photo to change the choice.`
            : "Nothing in your library is there twice, and no photos look nearly the same."}
        </p>
        {!hasIndex() ? (
          <p class="hint">Exact duplicates only. To also find similar photos (bursts, near-identical shots), turn on search in the Android or Mac app.</p>
        ) : missing > 0 ? (
          <p class="hint">{found.indexed} of {found.images} photos are indexed. Index more photos to find more.</p>
        ) : null}
        {groups.length > 0 && !p.demo && (
          <div class="row">
            <button class="btn danger" disabled={!live.length || busy} onClick={move}>
              <Icon name="trash" />{live.length ? `Move ${live.length} to trash` : "Nothing chosen"}
            </button>
          </div>
        )}
        {groups.length > 0 && <p class="hint">Photos in the trash can be restored for {p.retention} days.</p>}
      </section>

      <GroupList title="Exact duplicates" note="The same file, uploaded more than once." groups={found.exact.slice(0, limit)} byId={byId} chosen={chosen} toggle={toggle} />
      <GroupList title="Similar photos" note="Taken within minutes and looking nearly the same." groups={found.similar.slice(0, Math.max(0, limit - found.exact.length))} byId={byId} chosen={chosen} toggle={toggle} />
      {groups.length > limit && <button class="btn secondary" onClick={() => setLimit((l) => l + SHOWN)}>Show more groups</button>}
    </div>
  );
}

function GroupList(p: { title: string; note: string; groups: Group[]; byId: Map<string, Item>; chosen: Set<string>; toggle: (id: string) => void }) {
  if (!p.groups.length) return null;
  return (
    <section class="dupsection" aria-label={p.title}>
      <h2 class="peoplehead">{p.title}</h2>
      <p class="small">{p.note}</p>
      {p.groups.map((g) => {
        const kept = g.ids.filter((id) => !p.chosen.has(id)).length;
        return (
          <div class="dupgroup" key={g.ids.join()}>
            <ul class="duprow">
              {g.ids.map((id) => {
                const it = p.byId.get(id);
                if (!it) return null;
                const on = p.chosen.has(id);
                const m = it.meta;
                return (
                  <li key={id} class="dupitem">
                    <Tile item={it} selectMode selected={on} onOpen={() => p.toggle(id)} onToggle={() => p.toggle(id)} />
                    <span class="small">
                      {on ? <span class="pill disabled">Trash</span> : id === g.keep ? <span class="pill active">Keep</span> : <span class="pill">Keep</span>}
                      {" "}{m?.width && m?.height ? `${m.width}×${m.height} · ` : ""}{fmtSize(it.size)}{m?.gps ? " · location" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
            {kept === 0 && <p class="warning small" role="status">All of this group is chosen: none would be kept.</p>}
          </div>
        );
      })}
    </section>
  );
}
