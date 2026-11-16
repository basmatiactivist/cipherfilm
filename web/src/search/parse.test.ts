import { describe, expect, it } from "vitest";
import CASES from "./parse-cases.json";
import { fold, inWhen, parse, removeChip, textMatch, type ParseContext, type When } from "./parse";

// The same cases run on the Mac (QueryParserTests.swift), so all apps read a query alike.
const places = CASES.context.places as Record<string, string>;
const ctx: ParseContext = { people: CASES.context.people, today: CASES.context.today, place: (f) => (Object.hasOwn(places, f) ? places[f] : undefined) };

describe("combined search: the query parser", () => {
  for (const c of CASES.cases) {
    it(c.q, () => {
      const p = parse(c.q, ctx);
      expect(p.people).toEqual(c.people ?? []);
      expect(p.places).toEqual(c.places ?? []);
      expect(p.dates).toEqual(c.dates ?? []);
      expect(p.favorites).toBe(c.favorites ?? false);
      expect(p.videos).toBe(c.videos ?? false);
      expect(p.screenshots).toBe(c.screenshots ?? false);
      expect(p.text).toBe(c.text);
      expect(p.clip).toBe(c.clip ?? c.text);
      expect(p.chips.map((x) => [x.kind, x.start, x.end])).toEqual(c.chips);
    });
  }
  for (const r of CASES.remove) it(`removes chip ${r.chip} of ${r.q}`, () => expect(removeChip(r.q, parse(r.q, ctx).chips[r.chip])).toBe(r.out));
  for (const t of CASES.text) it(`text "${t.q}" in "${t.text}"`, () => expect(textMatch(t.text, t.q)).toBe(t.match));
  for (const w of CASES.when) it(`${JSON.stringify(w.when)} holds on ${w.day}: ${w.in}`, () => expect(inWhen(w.when as When, w.day)).toBe(w.in));
  it("folds accents, case and ß", () => expect(fold("Zürich STRAßE")).toBe("zurich strasse"));
  it("without people or places, names are just words", () => expect(parse("anna rome", { people: [], today: "2026-01-01" }).text).toBe("anna rome"));
});

describe("text in an index entry: the fixed-size slot", async () => {
  const { textSlot, TEXT_BYTES } = await import("../crypto/search");
  for (const c of CASES.slot) it(JSON.stringify(c.in).slice(0, 40), () => {
    const s = textSlot(c.in);
    expect(new TextEncoder().encode(s).length).toBe(TEXT_BYTES);
    expect(JSON.stringify(s).length - 2).toBe(s.length); // nothing in it needs escaping
    expect(s.trim()).toBe(c.out);
  });
});
