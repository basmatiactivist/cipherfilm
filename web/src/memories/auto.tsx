// Trips and year recaps on the web (trips.ts, recap.ts): worked out in this browser from the decrypted dates and
// coordinates, kept in memory only. Trips are suggested albums in Albums; a trip is saved as an ordinary encrypted
// album only when the person chooses to. Year recaps are a row of cards under "On this day".
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Item } from "../items";
import type { Album } from "../albums";
import { Tile } from "../grid";
import { Icon } from "../icons";
import { Loading } from "../loader";
import { loadPlaces } from "../map/locations";
import type { Places } from "../places/places";
import { findTrips, savedAs, tripDates, whereText, type Lookup, type Trip } from "./trips";
import { highlights, recapYears, yearRecap } from "./recap";

const monthFmt = new Intl.DateTimeFormat("en", { month: "long" });
const monthYearFmt = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });
const n = (k: number, one: string, many: string) => `${k.toLocaleString("en")} ${k === 1 ? one : many}`;

/** "Rome, May 2026"; "Italy and France, June – July 2025". */
export function tripTitle(t: Trip<Item>): string {
  const where = whereText(t.where);
  const when = tripDates(t.start, t.end, (ts) => monthFmt.format(ts), (ts) => monthYearFmt.format(ts));
  return where ? `${where}, ${when}` : `Trip, ${when}`;
}

/** The place file's lookup, each spot asked once (the same photo spots come up again and again). */
function cachedLookup(p: Places): Lookup {
  const seen = new Map<string, ReturnType<Places["nearest"]>>();
  return (lat, lon) => {
    const k = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (!seen.has(k)) seen.set(k, p.nearest(lat, lon));
    return seen.get(k);
  };
}

let lookup: Lookup | null = null;
const tripsOf = new WeakMap<Item[], Trip<Item>[]>();

/** The library's trips, newest first; null while the place file loads. Worked out again when the library changes. */
export function useTrips(items: Item[] | null, on: boolean): Trip<Item>[] | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on || lookup) return;
    let alive = true;
    loadPlaces().then((p) => { lookup = cachedLookup(p); if (alive) setTick((t) => t + 1); }, () => { /* no names: tried again next time */ });
    return () => { alive = false; };
  }, [on]);
  return useMemo(() => {
    if (!on || !items) return [];
    if (!lookup) return null;
    let t = tripsOf.get(items);
    if (!t) tripsOf.set(items, (t = findTrips(items, lookup)));
    return t;
  }, [items, on, lookup]);
}

/** Suggested albums: the trips, under the person's own albums. */
export function TripCards(p: { trips: Trip<Item>[] | null; albums: Album[]; onOpen: (key: string) => void }) {
  if (p.trips === null) return <Loading inline label="Looking for trips…" />;
  if (!p.trips.length) return null;
  return (
    <section class="trips" aria-labelledby="tripshead">
      <h2 class="memhead" id="tripshead">Trips</h2>
      <p class="small">Suggested from when and where your photos were taken, worked out in this browser. Save one to keep it as an album.</p>
      <ul class="albums" aria-label="Trips">
        {p.trips.map((t) => {
          const title = tripTitle(t);
          const saved = savedAs(t, p.albums);
          const cover = highlights(t.items, 1)[0] ?? t.items[0];
          return (
            <li key={t.key}>
              <button class="albumcard tripcard" onClick={() => p.onOpen(t.key)}>
                <span class="cover"><Tile plain item={cover} selectMode={false} selected={false} onOpen={() => {}} onToggle={() => {}} /></span>
                <span class="aname" dir="auto">{title}</span>
                <span class="small">{n(t.items.length, "item", "items")}{saved ? " · Saved" : ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Above a trip's photos: its days, and saving it as an album (or opening the album it was saved as). */
export function TripHeader(p: { trip: Trip<Item>; albums: Album[]; demo: boolean; onSave: () => Promise<void>; onOpenAlbum: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const saved = savedAs(p.trip, p.albums);
  const days = `${dayFmt.format(p.trip.start)} – ${dayFmt.format(p.trip.end)}`;
  return (
    <header class="albumhead triphead">
      <p class="small">{days} · {n(p.trip.items.length, "item", "items")}</p>
      <div class="row">
        {saved ? (
          <button class="btn secondary small" onClick={() => p.onOpenAlbum(saved.id)}><Icon name="albums" size={18} />Open the album</button>
        ) : !p.demo && (
          <button class="btn small" disabled={busy} onClick={async () => { setBusy(true); try { await p.onSave(); } finally { setBusy(false); } }}>
            <Icon name="folderPlus" size={18} />{busy ? "Saving…" : "Save as album"}
          </button>
        )}
      </div>
      {!saved && <p class="small hint">Only this browser knows about this trip until you save it. An album is encrypted like the rest.</p>}
    </header>
  );
}

/** Year cards under "On this day": every earlier year, and this one from December. */
export function RecapRow(p: { items: Item[]; onOpen: (year: number) => void }) {
  const cards = useMemo(() => recapYears(p.items).map((year) => {
    const list = p.items.filter((i) => !i.broken && !i.trashed_at && new Date(i.meta?.capture_ts ?? i.created_at * 1000).getFullYear() === year);
    const favs = list.filter((i) => i.favorite);
    return { year, cover: highlights(favs.length ? favs : list, 1)[0] ?? list[0], count: list.length };
  }).filter((c) => c.cover), [p.items]);
  if (!cards.length) return null;
  return (
    <section class="memories" aria-labelledby="recaphead">
      <h2 class="memhead" id="recaphead">Your years</h2>
      <ul class="memrow">
        {cards.map((c) => (
          <li key={c.year}>
            <button class="memcard" onClick={() => p.onOpen(c.year)} aria-label={`${c.year} in review, ${n(c.count, "item", "items")}`}>
              <span class="cover"><Tile plain item={c.cover} selectMode={false} selected={false} onOpen={() => {}} onToggle={() => {}} /></span>
              <span class="memago">{c.year}</span>
              <span class="small">In review</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface RecapPerson { key: string; name: string; items: string[] }

/** A year in review: the numbers, places and people seen most, its trips, and a few photos of each month. */
export function RecapPage(p: { year: number; items: Item[]; people: RecapPerson[]; trips: Trip<Item>[] | null; onOpenList: (list: Item[], i: number) => void; onOpenTrip: (key: string) => void; onOpenPerson: (key: string) => void }) {
  const [names, setNames] = useState<Lookup | null>(lookup);
  useEffect(() => { if (!names) loadPlaces().then((pl) => { lookup ??= cachedLookup(pl); setNames(() => lookup); }, () => {}); }, []);
  const r = useMemo(() => yearRecap(p.items, p.year, { lookup: names ?? undefined, people: p.people }), [p.items, p.year, names, p.people]);
  if (!r) return <section class="panel empty"><span class="emptyicon"><Icon name="photos" size={32} /></span><h2>No photos from {p.year}</h2><p>Photos and videos taken in {p.year} show up here.</p></section>;
  const trips = (p.trips ?? []).filter((t) => new Date(t.start).getFullYear() === p.year || new Date(t.end).getFullYear() === p.year);
  const byKey = new Map(p.people.map((x) => [x.key, x]));
  const facts = [n(r.photos, "photo", "photos"), r.videos ? n(r.videos, "video", "videos") : "", n(r.days, "day", "days"), r.countries > 1 ? n(r.countries, "country", "countries") : ""].filter(Boolean);
  return (
    <div class="recap">
      <p class="recapfacts">{facts.join(" · ")}</p>
      {!names && <Loading inline label="Naming places…" />}
      {r.places.length > 0 && (
        <section aria-labelledby="rplaces">
          <h2 class="memhead" id="rplaces">Places</h2>
          <ul class="memrow">
            {r.places.map((pl) => (
              <li key={pl.name + pl.countryCode}>
                <div class="memcard static">
                  <span class="cover"><Tile plain item={pl.cover} selectMode={false} selected={false} onOpen={() => {}} onToggle={() => {}} /></span>
                  <span class="memago" dir="auto">{pl.name}</span>
                  <span class="small">{pl.country} · {n(pl.count, "item", "items")}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {r.people.length > 0 && (
        <section aria-labelledby="rpeople">
          <h2 class="memhead" id="rpeople">People</h2>
          <ul class="chips">
            {r.people.map((x) => <li key={x.key}><button class="chip" onClick={() => p.onOpenPerson(x.key)}><Icon name="user" size={18} />{byKey.get(x.key)?.name}<span class="small">{x.count}</span></button></li>)}
          </ul>
        </section>
      )}
      {trips.length > 0 && (
        <section aria-labelledby="rtrips">
          <h2 class="memhead" id="rtrips">Trips</h2>
          <ul class="chips">
            {trips.map((t) => <li key={t.key}><button class="chip" onClick={() => p.onOpenTrip(t.key)}><Icon name="map" size={18} />{tripTitle(t)}</button></li>)}
          </ul>
        </section>
      )}
      {r.months.map((m) => (
        <section key={m.month} class="recapmonth" aria-labelledby={`rm${m.month}`}>
          <h2 class="memhead" id={`rm${m.month}`}>{monthFmt.format(new Date(p.year, m.month, 1))} <span class="small">{n(m.total, "item", "items")}</span></h2>
          <ul class="recaptiles">
            {m.highlights.map((it, i) => (
              <li key={it.id}><Tile item={it} selectMode={false} selected={false} onOpen={() => p.onOpenList(m.highlights, i)} onToggle={() => {}} /></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
