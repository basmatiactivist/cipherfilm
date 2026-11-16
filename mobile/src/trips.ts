// Trips and year recaps on the phone (web/src/memories/trips.ts and recap.ts, shared through @memories): worked out
// here from the decrypted dates and places, kept in memory only. A trip reaches the server only when the person saves
// it as an album (then it is an ordinary encrypted album). They follow the Memories setting, like "On this day".
import { useEffect, useMemo, useState } from "react";
import { findTrips, tripDates, whereText, type Lookup, type Trip } from "@memories/trips";
import { recapYears } from "@memories/recap";
import type { Places } from "@places/places";
import type { Item } from "./library";
import { useMemoriesOn } from "./memories";
import { loadPlaces, local } from "./places";
import { currentLang, locale, t } from "./i18n";
import { onWipe } from "./session";

export type { Trip };

/** The place file's lookup with countries in the app's language, each spot asked once. */
function cachedLookup(p: Places): Lookup {
  const seen = new Map<string, ReturnType<Places["nearest"]>>();
  return (lat, lon) => {
    const k = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (!seen.has(k)) seen.set(k, local(p, p.nearest(lat, lon)));
    return seen.get(k);
  };
}

let lookup: { lang: string; f: Lookup } | null = null;
let cached: { items: Item[]; lang: string; trips: Trip<Item>[] } | null = null;

/** The lookup for the app's language, once the place file is read (null until then). */
export function usePlaceLookup(on = true): Lookup | null {
  const lang = currentLang();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on || lookup?.lang === lang) return;
    let live = true;
    loadPlaces().then((p) => { lookup = { lang, f: cachedLookup(p) }; if (live) setTick((n) => n + 1); }, () => { /* no names: tried again next time */ });
    return () => { live = false; };
  }, [on, lang]);
  return on && lookup?.lang === lang ? lookup.f : null;
}

/** The library's trips, newest first; null while the place file loads, [] when Memories are off. */
export function useTrips(items: Item[] | null): Trip<Item>[] | null {
  const on = useMemoriesOn();
  const f = usePlaceLookup(on);
  const lang = currentLang();
  return useMemo(() => {
    if (!on || !items) return [];
    if (!f) return null;
    if (cached?.items !== items || cached.lang !== lang) cached = { items, lang, trips: findTrips(items, f) };
    return cached.trips;
  }, [items, on, f, lang]);
}

/** The years with a recap (newest first), [] when Memories are off. */
export function useRecapYears(items: Item[] | null): number[] {
  const on = useMemoriesOn();
  return useMemo(() => (on && items ? recapYears(items) : []), [items, on]);
}

/** "Rom, Mai 2026" in German, "Italy and France, June – July 2025" in English. */
export function tripTitle(tr: Trip<Item>): string {
  const month = new Intl.DateTimeFormat(locale(), { month: "long" });
  const monthYear = new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" });
  const where = whereText(tr.where, t("and"), (n) => t("{n} more", { n }));
  const when = tripDates(tr.start, tr.end, (ts) => month.format(ts), (ts) => monthYear.format(ts));
  return where ? `${where}, ${when}` : t("Trip, {when}", { when });
}

/** Forget what was worked out (sign-out, lock). */
export function forgetTrips() { cached = null; }
onWipe(forgetTrips);
