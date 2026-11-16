import { describe, expect, it } from "vitest";
import type { Item } from "../items";
import { chipLabel, narrow, textHits, whenLabel } from "./combined";
import { parse } from "./parse";

const item = (id: string, at: string, more: Partial<Item> = {}): Item =>
  ({ id, kind: "image", favorite: false, created_at: 0, meta: { name: `${id}.jpg`, capture_ts: new Date(at).getTime() }, ...more }) as unknown as Item;

const lib = [
  item("a", "2025-05-03T12:00:00", { favorite: true }),
  item("b", "2025-05-20T12:00:00"),
  item("c", "2024-05-20T12:00:00"),
  item("d", "2025-08-01T12:00:00", { kind: "video" } as Partial<Item>),
];
const facts = { people: new Map([["Anna Müller", new Set(["a", "b", "d"])]]), places: new Map([["a", ["Rome", "Lazio", "Italy"]], ["b", ["Paris", "Île-de-France", "France"]], ["d", ["Rome", "Lazio", "Italy"]]]) };
const ctx = { people: ["Anna Müller"], today: "2026-11-16", place: (f: string) => ({ rome: "Rome", rom: "Rome", italy: "Italy" } as Record<string, string>)[f] };

describe("combined search on the web", () => {
  it("dog beach May 2025 Anna Rome: every filter narrows, the rest is left for content", () => {
    const p = parse("dog beach May 2025 Anna Rome", ctx);
    expect(narrow(lib, p, facts).map((i) => i.id)).toEqual(["a"]);
    expect(p.clip).toBe("dog beach");
  });
  it("Hund 2025 Anna Rom", () => expect(narrow(lib, parse("Hund 2025 Anna Rom", ctx), facts).map((i) => i.id)).toEqual(["a", "d"]));
  it("videos, favorites, years", () => {
    expect(narrow(lib, parse("videos", ctx), facts).map((i) => i.id)).toEqual(["d"]);
    expect(narrow(lib, parse("favorites", ctx), facts).map((i) => i.id)).toEqual(["a"]);
    expect(narrow(lib, parse("mai", ctx), facts).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(narrow(lib, parse("2024-2025 italy", ctx), facts).map((i) => i.id)).toEqual(["a", "d"]);
  });
  it("finds photos by the text read in them", () => {
    const text = (id: string) => (id === "b" ? "BAKERY OPEN Zürich Hauptbahnhof" : "");
    expect([...textHits(lib, "zurich bakery", text).keys()]).toEqual(["b"]);
    expect(textHits(lib, "", text).size).toBe(0);
  });
  it("labels chips", () => {
    expect(whenLabel({ from: "2025-05-01", to: "2025-05-31" })).toBe("May 2025");
    expect(whenLabel({ from: "2019-01-01", to: "2021-12-31" })).toBe("2019–2021");
    expect(whenLabel({ from: "2020-01-01" })).toBe("Since 2020");
    expect(whenLabel({ to: "2019-12-31" })).toBe("Until 2019");
    expect(whenLabel({ months: [4, 6] })).toBe("May–July");
    expect(whenLabel({ months: [11, 11], days: [20, 27] })).toBe("Christmas");
    expect(whenLabel({ from: "2023-12-20", to: "2023-12-27" })).toBe("Christmas 2023");
    expect(whenLabel({ from: "2025-05-01", to: "2025-07-31" })).toBe("May–July 2025");
    expect(chipLabel(parse("anna", ctx).chips[0])).toBe("Anna Müller");
  });
});
