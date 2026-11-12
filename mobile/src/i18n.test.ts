import { describe, expect, it } from "vitest";
import { de } from "./i18n.de";
import { currentLang, detectLang, refreshLang, setLang, subscribeLang, t, tn } from "./i18n";

// every literal handed to t() or tn() in the app, read from the source (Vite reads the files: no Node types here)
declare global { interface ImportMeta { glob(pattern: string[], o: { query: "?raw"; import: "default"; eager: true }): Record<string, string> } }
const sources = Object.values(import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.ts", "!./i18n*.ts", "!./i18n/**"], { query: "?raw", import: "default", eager: true }));
function literals(src: string): string[] {
  const out: string[] = [];
  const str = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
  for (const m of src.matchAll(new RegExp(String.raw`\bt\(\s*` + str, "g"))) out.push(m[1]);
  for (const m of src.matchAll(new RegExp(String.raw`\btn\(\s*[^,]+,\s*` + str + String.raw`\s*,\s*` + str, "g"))) out.push(m[1], m[2]);
  return out.map(unquote);
}

// a JS string literal's text, either quote: the escapes the app's texts use, read one by one (no re-quoting)
const ESC: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'" };
function unquote(q: string): string {
  return q.slice(1, -1).replace(/\\(.)/g, (_m, c: string) => ESC[c] ?? c);
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
    expect(t("action|Trash")).toBe("Trash");
    expect(tn(1, "{n} photo", "{n} photos")).toBe("1 photo");
    setLang("de");
    expect(t("not translated")).toBe("not translated");
    expect(t("action|Trash")).toBe("Löschen");
    expect(t("Trash")).toBe("Papierkorb");
    setLang("en");
  });
});

describe("a language change while the app runs", () => {
  it("is taken up when the app asks again, tells the root once, and the words follow at once", () => {
    setLang("en");
    let told = 0;
    const off = subscribeLang(() => told++);
    expect(refreshLang(() => "en-GB")).toBe(false); // still English: nothing renders again
    expect(told).toBe(0);
    expect(refreshLang(() => "de-AT")).toBe(true); // changed in Android's settings
    expect(currentLang()).toBe("de");
    expect(told).toBe(1);
    expect(t("Trash")).toBe("Papierkorb");
    expect(refreshLang(() => "de-DE")).toBe(false); // the same language again
    expect(told).toBe(1);
    setLang("de"); // no change: no render
    expect(told).toBe(1);
    expect(refreshLang(() => "fr-FR")).toBe(true); // anything else is English
    expect(t("Trash")).toBe("Trash");
    expect(told).toBe(2);
    off();
    setLang("de");
    expect(told).toBe(2); // unsubscribed
    setLang("en");
  });

  it("falls back to the JavaScript engine's language when the native side can't say", () => {
    setLang("de");
    const engine = detectLang();
    refreshLang(() => null);
    expect(currentLang()).toBe(engine);
    refreshLang(() => { throw new Error("no native module"); });
    expect(currentLang()).toBe(engine);
    refreshLang(); // in plain Node there is no native module either
    expect(currentLang()).toBe(engine);
    setLang("en");
  });
});

