import { describe, expect, it } from "vitest";
import { de } from "./i18n.de";
import { detectLang, setLang, t, tn } from "./i18n";

// every literal handed to t() or tn() in the app, read from the source (Vite reads the files: no Node types here)
declare global { interface ImportMeta { glob(pattern: string[], o: { query: "?raw"; import: "default"; eager: true }): Record<string, string> } }
const sources = Object.values(import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.ts", "!./i18n*.ts", "!./i18n/**"], { query: "?raw", import: "default", eager: true }));
function literals(src: string): string[] {
  const out: string[] = [];
  const str = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
  for (const m of src.matchAll(new RegExp(String.raw`\bt\(\s*` + str, "g"))) out.push(m[1]);
  for (const m of src.matchAll(new RegExp(String.raw`\btn\(\s*[^,]+,\s*` + str + String.raw`\s*,\s*` + str, "g"))) out.push(m[1], m[2]);
  return out.map((q) => JSON.parse(q[0] === "'" ? '"' + q.slice(1, -1).replace(/"/g, '\\"').replace(/\\'/g, "'") + '"' : q));
}

describe("i18n", () => {
  it("has German for every text the app shows through t() and tn()", () => {
    const missing = new Set<string>();
    let count = 0;
    for (const src of sources) for (const s of literals(src)) { count++; if (!(s in de)) missing.add(s); }
    expect(count).toBeGreaterThan(0);
    expect([...missing]).toEqual([]);
  });

  it("keeps the placeholders of every German text", () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    const wrong = Object.entries(de).filter(([en, g]) => names(en) !== names(g)).map(([en]) => en);
    expect(wrong).toEqual([]);
  });

  it("picks German only for German locales and fills placeholders", () => {
    expect(detectLang("de-CH")).toBe("de");
    expect(detectLang("de")).toBe("de");
    expect(detectLang("en-US")).toBe("en");
    expect(detectLang("fr-FR")).toBe("en");
    setLang("en");
    expect(t("x {n} y", { n: 3 })).toBe("x 3 y");
    expect(tn(1, "{n} photo", "{n} photos")).toBe("1 photo");
    setLang("de");
    expect(t("not translated")).toBe("not translated");
    setLang("en");
  });
});
