// One search box, many kinds of words (docs/SEARCH.md "Combined search"): "dog beach May 2025 Anna Rome" or
// "Hund Strand 2025 Anna Rom" is the photos of Anna, taken in Rome in May 2025 (or in 2025), that show a dog on a beach.
// This file splits such a query into filters (people, dates, places, favorites, videos, screenshots) and the words
// left for what is in a photo (the image model) and the text in it. Shared by the web and the Android app
// (mobile/ imports it as @websearch/parse); the Mac has a careful port (mac/.../QueryParser.swift). The same cases
// (parse-cases.json) test all of them. Pure: nothing is looked up here but what the caller passes.
import GLOSSARY from "./glossary-de.json";

export interface ParseContext {
  /** Names of the account's named people (hidden ones left out). */
  people: string[];
  /** A place name for a folded phrase of one to three words ("rom", "new york"), when the library has photos there:
   *  the canonical name ("Rome"), else undefined. */
  place?: (folded: string) => string | undefined;
  /** Today, "YYYY-MM-DD", for "this year" and "last year". */
  today: string;
}

/** A date filter. All parts given must hold: from/to are inclusive local dates ("YYYY-MM-DD"); months (0..11) and
 *  days (1..31) are inclusive ranges that hold in any year. */
export interface When { from?: string; to?: string; months?: [number, number]; days?: [number, number] }

export type ChipKind = "person" | "place" | "date" | "favorites" | "videos" | "screenshots";

/** What a part of the query was taken as, with the words it covers: tokens [start, end) of the query split at
 *  whitespace. Removing the chip removes those words (removeChip). */
export interface Chip { kind: ChipKind; start: number; end: number; names?: string[]; place?: string; when?: When }

export interface Parsed {
  chips: Chip[];
  /** Each entry is one name in the query; a photo needs one of its people (two Annas: either). All entries hold. */
  people: string[][];
  places: string[];
  dates: When[];
  favorites: boolean;
  videos: boolean;
  screenshots: boolean;
  /** The words left, lower case: matched against file names, albums and the text in photos. */
  text: string;
  /** The same words for the image model, which knows English: common German words in English ("hund" → "dog"). */
  clip: string;
}

/** Lower case, accents dropped, ß as ss: "Zürich" and "zurich", "Müller" and "muller" match. */
export const fold = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").normalize("NFC");

/** Query tokens: the query split at whitespace, as typed. Chips point into this list. */
export const tokens = (q: string): string[] => q.trim().split(/\s+/).filter(Boolean);

const trim = (t: string): string => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
/** A token without the punctuation around it, folded: "Mai," → "mai"; one of only punctuation ("-") stays. */
const word = (t: string): string => trim(fold(t)) || fold(t);
const hasWord = (t: string): boolean => /[\p{L}\p{N}]/u.test(t);

const MONTHS: Record<string, number> = {};
["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
  .forEach((m, i) => { MONTHS[m] = i; MONTHS[m.slice(0, 3)] = i; });
["januar", "februar", "marz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"]
  .forEach((m, i) => { MONTHS[m] = i; MONTHS[m.slice(0, 3)] = i; });
Object.assign(MONTHS, { janner: 0, maerz: 2, sept: 8, okt: 9, dez: 11 });

const isYear = (w: string) => /^(19|20)\d\d$/.test(w);
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const yearsWhen = (a: number, b: number): When => ({ from: `${a}-01-01`, to: `${b}-12-31` });
const monthsWhen = (y: number, a: number, b: number): When => ({ from: `${y}-${pad(a + 1)}-01`, to: `${y}-${pad(b + 1)}-${pad(lastDay(y, b))}` });

const RANGE_TO = new Set(["to", "bis", "-", "–", "until", "till", "and", "und"]);
const RANGE_FROM = new Set(["from", "von", "between", "zwischen"]);
const SINCE = new Set(["since", "seit", "after", "nach", "ab"]);
const BEFORE = new Set(["before", "vor"]);
const CHRISTMAS = new Set(["christmas", "xmas", "weihnachten"]);
/** Words before a filter that belong to it: "dog in Rome", "photos with Anna", "from 2024". */
const LEAD = new Set(["in", "im", "at", "from", "von", "aus", "bei", "near", "on", "am", "during", "wahrend", "with", "mit", "of"]);
/** Words that mean "any photo": dropped from what is searched for. */
const FILLER = new Set(["photo", "photos", "picture", "pictures", "pics", "pic", "image", "images", "foto", "fotos", "bild", "bilder", "aufnahmen"]);
const FLAGS: [ChipKind, RegExp][] = [
  ["favorites", /^(favou?rites?|favorit(e|en)?|favs?|liked|herz|hearts?|lieblingsfotos|lieblingsbilder)$/],
  ["videos", /^(videos?|filme?|clips?|movies?)$/],
  ["screenshots", /^(screenshots?|bildschirmfotos?)$/],
];

/** Small words a photo's text needn't contain for a match ("the" in "the bakery"). */
const STOP = new Set(["a", "an", "the", "and", "or", "of", "in", "on", "at", "with", "der", "die", "das", "ein", "eine", "und", "oder", "im", "am", "mit", "auf", "von"]);

const glossary = new Map(Object.entries(GLOSSARY as Record<string, string>));
const isMonth = (w: string | undefined): w is string => w !== undefined && Object.hasOwn(MONTHS, w);

interface Found { kind: ChipKind; len: number; names?: string[]; place?: string; when?: When }

/** A date starting at word i: "2025", "2019-2021", "2019 bis 2021", "May 2025", "Mai bis Juli 2025", "since 2020",
 *  "christmas 2023", "2025-05", "24.12.2023", "last year". */
function dateAt(w: string[], i: number, today: string): Found | null {
  const a = w[i], b = w[i + 1], c = w[i + 2];
  const thisYear = +today.slice(0, 4);
  // "last year", "this year", "letztes Jahr", "dieses Jahr", "vorletztes jahr"
  if ((b === "year" || b === "jahr") && ["last", "letztes", "this", "dieses", "vorletztes"].includes(a)) {
    const y = a === "this" || a === "dieses" ? thisYear : a === "vorletztes" ? thisYear - 2 : thisYear - 1;
    return { kind: "date", len: 2, when: yearsWhen(y, y) };
  }
  // exact days and months typed as numbers
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(a) ?? null;
  if (m && isYear(m[1])) { const day = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`; return { kind: "date", len: 1, when: { from: day, to: day } }; }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(a);
  if (m && isYear(m[3])) { const day = `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`; return { kind: "date", len: 1, when: { from: day, to: day } }; }
  m = /^(\d{4})-(\d{1,2})$/.exec(a);
  if (m && isYear(m[1]) && +m[2] >= 1 && +m[2] <= 12) return { kind: "date", len: 1, when: monthsWhen(+m[1], +m[2] - 1, +m[2] - 1) };
  // year ranges: "2019-2021", "2019–2021"
  m = /^(\d{4})[-–](\d{4})$/.exec(a);
  if (m && isYear(m[1]) && isYear(m[2])) return { kind: "date", len: 1, when: yearsWhen(Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])) };
  // "from 2019 to 2021", "zwischen 2019 und 2021", "2019 bis 2021"
  const lead = RANGE_FROM.has(a) ? 1 : 0;
  const y0 = w[i + lead], sep = w[i + lead + 1], y1 = w[i + lead + 2];
  if (isYear(y0) && sep && RANGE_TO.has(sep) && isYear(y1)) return { kind: "date", len: lead + 3, when: yearsWhen(Math.min(+y0, +y1), Math.max(+y0, +y1)) };
  if (SINCE.has(a) && isYear(b)) return { kind: "date", len: 2, when: { from: `${+b + (a === "after" || a === "nach" ? 1 : 0)}-01-01` } };
  if ((BEFORE.has(a) || (a === "until" || a === "bis")) && isYear(b)) return { kind: "date", len: 2, when: { to: a === "before" || a === "vor" ? `${+b - 1}-12-31` : `${b}-12-31` } };
  // christmas, with or without a year
  if (CHRISTMAS.has(a)) {
    if (isYear(b)) return { kind: "date", len: 2, when: { from: `${b}-12-20`, to: `${b}-12-27` } };
    return { kind: "date", len: 1, when: { months: [11, 11], days: [20, 27] } };
  }
  // months: "may", "may 2025", "2025 may", "may to july", "mai bis juli 2025"
  if (isMonth(a)) {
    let m0 = MONTHS[a], m1 = m0, len = 1;
    if (b && RANGE_TO.has(b) && isMonth(c)) { m1 = MONTHS[c]; len = 3; }
    const y = w[i + len];
    if (m1 < m0) [m0, m1] = [m1, m0];
    if (isYear(y)) return { kind: "date", len: len + 1, when: monthsWhen(+y, m0, m1) };
    return { kind: "date", len, when: { months: [m0, m1] } };
  }
  if (isYear(a)) {
    if (isMonth(b)) return { kind: "date", len: 2, when: monthsWhen(+a, MONTHS[b], MONTHS[b]) };
    return { kind: "date", len: 1, when: yearsWhen(+a, +a) };
  }
  return null;
}

/** People whose name is the words at i (all of it: "anna müller") or one word of it ("anna"). Longest first. */
function personAt(w: string[], i: number, people: { name: string; parts: string[] }[]): Found | null {
  for (const len of [3, 2]) {
    if (i + len > w.length) continue;
    const phrase = w.slice(i, i + len).join(" ");
    const hits = people.filter((p) => p.parts.join(" ") === phrase);
    if (hits.length) return { kind: "person", len, names: hits.map((p) => p.name) };
  }
  const hits = people.filter((p) => p.parts.includes(w[i]));
  return hits.length ? { kind: "person", len: 1, names: hits.map((p) => p.name) } : null;
}

function placeAt(w: string[], i: number, place: ParseContext["place"]): Found | null {
  if (!place) return null;
  for (const len of [3, 2, 1]) {
    if (i + len > w.length) continue;
    const name = place(w.slice(i, i + len).join(" "));
    if (name) return { kind: "place", len, place: name };
  }
  return null;
}

export function parse(q: string, ctx: ParseContext): Parsed {
  const raw = tokens(q);
  const w = raw.map(word);
  const people = ctx.people
    .map((name) => ({ name, parts: fold(name).split(/\s+/).map(trim).filter(Boolean) }))
    .filter((p) => p.parts.length);
  const chips: Chip[] = [];
  const used = new Array(raw.length).fill(false);
  for (let i = 0; i < w.length;) {
    if (!hasWord(w[i])) { i++; continue; }
    const flag = FLAGS.find(([, re]) => re.test(w[i]));
    const f: Found | null = personAt(w, i, people) ?? dateAt(w, i, ctx.today) ?? (flag ? { kind: flag[0], len: 1 } : null) ?? placeAt(w, i, ctx.place);
    if (!f) { i++; continue; }
    let start = i;
    // a word like "in" or "with" right before it goes with it, unless it is all that is left before
    if (start > 0 && LEAD.has(w[start - 1]) && !used[start - 1]) start--;
    // "from" in "from 2019 to 2021" is part of the date already
    const chip: Chip = { kind: f.kind, start, end: i + f.len };
    if (f.names) chip.names = f.names;
    if (f.place) chip.place = f.place;
    if (f.when) chip.when = f.when;
    chips.push(chip);
    for (let k = start; k < i + f.len; k++) used[k] = true;
    i += f.len;
  }
  const rest = w.filter((x, k) => !used[k] && hasWord(x) && !FILLER.has(x));
  // a word like "in" left over at the very end ("dog in") means nothing
  while (rest.length && LEAD.has(rest[rest.length - 1])) rest.pop();
  while (rest.length && LEAD.has(rest[0])) rest.shift();
  return {
    chips,
    people: chips.filter((c) => c.kind === "person").map((c) => c.names!),
    places: chips.filter((c) => c.kind === "place").map((c) => c.place!),
    dates: chips.filter((c) => c.kind === "date").map((c) => c.when!),
    favorites: chips.some((c) => c.kind === "favorites"),
    videos: chips.some((c) => c.kind === "videos"),
    screenshots: chips.some((c) => c.kind === "screenshots"),
    text: rest.join(" "),
    clip: rest.map((x) => glossary.get(x) ?? x).join(" "),
  };
}

/** The query without a chip's words: what the search box holds after the chip's × was pressed. */
export function removeChip(q: string, chip: Chip): string {
  return tokens(q).filter((_, i) => i < chip.start || i >= chip.end).join(" ");
}

/** Whether a photo taken on this local day ("YYYY-MM-DD") passes a date filter. */
export function inWhen(when: When, day: string): boolean {
  if (when.from && day < when.from) return false;
  if (when.to && day > when.to) return false;
  const m = +day.slice(5, 7) - 1, d = +day.slice(8, 10);
  if (when.months && (m < when.months[0] || m > when.months[1])) return false;
  if (when.days && (d < when.days[0] || d > when.days[1])) return false;
  return true;
}

/** The local day of a time in milliseconds, "YYYY-MM-DD". */
export const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Where the words are in a photo's recognised text: each query word must start a word of the text (folded, so
 *  "zurich" finds "Zürich"; "bake" finds "Bakery"). Returns a short piece of the text around the first match, as it
 *  was recognised, or null. */
export function textMatch(text: string | undefined, query: string): string | null {
  if (!text) return null;
  const qs = fold(query).split(/\s+/).map(trim).filter((x) => x && !STOP.has(x));
  if (!qs.length) return null;
  const words = text.split(/\s+/).filter(Boolean);
  const folded = words.map((x) => fold(x).replace(/^[^\p{L}\p{N}]+/u, ""));
  let first = -1;
  for (const q of qs) {
    const at = folded.findIndex((x) => x.startsWith(q));
    if (at < 0) return null;
    if (first < 0 || at < first) first = at;
  }
  const from = Math.max(0, first - 2);
  const piece = words.slice(from, from + 8).join(" ");
  return (from > 0 ? "…" : "") + piece + (from + 8 < words.length ? "…" : "");
}
