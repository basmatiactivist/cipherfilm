import { beforeEach, describe, expect, it, vi } from "vitest";

// One search box (docs/SEARCH.md "Combined search"): the shared parser splits the query into filters (shown as chips)
// and the words left; filters all hold; results come as name matches, place matches, text in photos, then the model's.
const st = vi.hoisted(() => ({
  clip: [] as { id: string; score: number }[], // what the image model ranks for the words
  clipAsked: [] as string[],
  texts: {} as Record<string, string>, // the text in photos
  groups: [] as { key: string; person?: { name: string; hidden?: boolean }; items: string[] }[],
  places: {} as Record<string, string[]>, // place name -> photos there
}));
vi.mock("./engine", async () => {
  const { textMatch } = await import("@websearch/parse");
  return {
    textSearch: async (q: string) => { st.clipAsked.push(q); return st.clip; },
    textHits: (ids: Iterable<string>, q: string) => [...ids].map((id) => ({ id, snippet: textMatch(st.texts[id], q) })).filter((x) => x.snippet),
  };
});
vi.mock("./people", () => ({ peopleGroups: async () => st.groups }));
vi.mock("../library", () => ({ when: (it: { meta?: { capture_ts?: number }; created_at: number }) => it.meta?.capture_ts ?? it.created_at * 1000 }));
vi.mock("../places", async () => {
  const { fold } = await import("@websearch/parse");
  return {
    placeIndex: async () => ({
      find: (q: string) => Object.keys(st.places).find((n) => fold(n) === q && st.places[n].length > 0), // only where photos are
      ids: (name: string) => new Set(st.places[name] ?? []),
    }),
    inPlace: async () => null,
  };
});

const { chipLabel, removeChip, search, whenLabel } = await import("./query");
const { setLang } = await import("../i18n");

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const item = (id: string, ts: number, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "image", created_at: 0, size: 1, segment_count: 1, meta: { name: `IMG_${id}.jpg`, size: 1, capture_ts: ts }, ...extra }) as never;
const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);

const LIB = [
  item("a1", at(2025, 5, 3)), // Anna, Rome, May 2025, a dog on the beach
  item("a2", at(2025, 7, 1)), // Anna, Rome, July 2025
  item("a3", at(2024, 5, 3)), // Anna, Rome, 2024
  item("b1", at(2025, 5, 4)), // Ben, Rome
  item("z1", at(2023, 12, 24), { favorite: true }), // Zurich, Christmas, a sign
  item("v1", at(2025, 5, 5), { kind: "video" }),
  item("s1", at(2025, 5, 6), { meta: { name: "Screenshot_2025.png", size: 1, capture_ts: at(2025, 5, 6) } }),
];

beforeEach(() => {
  setLang("en");
  st.clip = []; st.clipAsked = [];
  st.texts = { z1: "BAKERY OPEN Zürich Hauptbahnhof Gleis 7 Fresh bread daily", s1: "Settings Wi-Fi Bluetooth" };
  st.groups = [
    { key: "p1", person: { name: "Anna Müller" }, items: ["a1", "a2", "a3"] },
    { key: "p2", person: { name: "Ben" }, items: ["b1"] },
    { key: "p3", person: { name: "Hidden Person", hidden: true }, items: ["z1"] },
  ];
  st.places = { Rome: ["a1", "a2", "a3", "b1", "v1"], Zurich: ["z1"], Paris: [] };
});

describe("combined search", () => {
  it("narrows by all filters at once and ranks the words left with the image model", async () => {
    st.clip = [{ id: "b1", score: 0.3 }, { id: "a1", score: 0.29 }, { id: "a2", score: 0.2 }];
    const r = await search("Hund Strand Mai 2025 Anna Rome", LIB, "2026-11-16");
    expect(st.clipAsked).toEqual(["dog beach"]); // German words for the image model in English
    expect(ids(r)).toEqual(["a1"]); // Ben's isn't Anna's, a2 isn't from May
    expect(r.chips.map((c) => [c.kind, c.label])).toEqual([["date", "May 2025"], ["person", "Anna Müller"], ["place", "Rome"]]);
    expect(r.people.map((g) => g.key)).toEqual(["p1"]);
  });

  it("a place in the library is a chip; one where no photo is stays a word", async () => {
    const r = await search("dog in Rome 2025", LIB, "2026-11-16");
    expect(r.chips.map((c) => [c.kind, c.label, c.start, c.end])).toEqual([["place", "Rome", 1, 3], ["date", "2025", 3, 4]]);
    const r2 = await search("paris", LIB, "2026-11-16");
    expect(r2.chips).toEqual([]);
  });

  it("filters alone give their photos newest first", async () => {
    expect(ids(await search("Anna 2025", LIB, "2026-11-16"))).toEqual(["a2", "a1"]);
    expect(ids(await search("videos", LIB, "2026-11-16"))).toEqual(["v1"]);
    expect(ids(await search("favorites", LIB, "2026-11-16"))).toEqual(["z1"]);
    expect(ids(await search("screenshots", LIB, "2026-11-16"))).toEqual(["s1"]);
    expect(ids(await search("weihnachten", LIB, "2026-11-16"))).toEqual(["z1"]);
    expect(ids(await search("last year", LIB, "2026-11-16"))).toEqual(["a2", "s1", "v1", "b1", "a1"]);
  });

  it("hidden people aren't filters", async () => {
    const r = await search("hidden", LIB, "2026-11-16");
    expect(r.chips).toEqual([]);
  });

  it("orders file names, then the text in photos, then the model's ranking, each photo once", async () => {
    st.clip = [{ id: "a1", score: 0.3 }, { id: "z1", score: 0.2 }];
    const r = await search("bakery", LIB, "2026-11-16");
    expect(ids(r)).toEqual(["z1", "a1"]);
    expect(r.snippets).toEqual({ z1: "BAKERY OPEN Zürich Hauptbahnhof Gleis 7 Fresh bread…" });
    st.clip = [{ id: "a1", score: 0.3 }];
    const named = await search("img_v1", LIB, "2026-11-16");
    expect(ids(named)).toEqual(["v1", "a1"]);
  });

  it("the text in photos is matched folded and by word starts; filters apply to it too", async () => {
    expect(ids(await search("zurich hauptbahn", LIB, "2026-11-16"))).toEqual(["z1"]);
    expect(ids(await search("hauptbahnhof 2025", LIB, "2026-11-16"))).toEqual([]);
    expect(ids(await search("bluetooth screenshots", LIB, "2026-11-16"))).toEqual(["s1"]);
  });

  it("a chip's × takes its words out of the query", async () => {
    const q = "dog with Anna in Rome may 2025";
    const r = await search(q, LIB, "2026-11-16");
    const person = r.chips.find((c) => c.kind === "person")!;
    expect(removeChip(q, person)).toBe("dog in Rome may 2025");
    const place = r.chips.find((c) => c.kind === "place")!;
    expect(removeChip(q, place)).toBe("dog with Anna may 2025");
  });

  it("names the dates on chips in words", () => {
    expect(whenLabel({ from: "2025-01-01", to: "2025-12-31" })).toBe("2025");
    expect(whenLabel({ from: "2019-01-01", to: "2021-12-31" })).toBe("2019 – 2021");
    expect(whenLabel({ from: "2025-05-01", to: "2025-07-31" })).toBe("May – July 2025");
    expect(whenLabel({ months: [4, 4] })).toBe("May");
    expect(whenLabel({ months: [11, 11], days: [20, 27] })).toBe("Christmas");
    expect(whenLabel({ from: "2023-12-20", to: "2023-12-27" })).toBe("Christmas 2023");
    expect(whenLabel({ from: "2020-01-01" })).toBe("Since 2020");
    expect(whenLabel({ to: "2019-12-31" })).toBe("Until 2019");
    expect(chipLabel({ kind: "person", start: 0, end: 1, names: ["Anna A", "Anna B"] }, ["anna"])).toBe("anna");
    setLang("de");
    expect(whenLabel({ from: "2025-05-01", to: "2025-05-31" })).toBe("Mai 2025");
    expect(chipLabel({ kind: "favorites", start: 0, end: 1 }, ["favoriten"])).toBe("Favoriten");
    setLang("en");
  });
});
