// CLIP's byte-level BPE tokenizer (the one LAION's ViT-B/32 uses), read from the model's tokenizer.json: lowercase, split
// into words, numbers and punctuation, then merge byte pairs in rank order. Context of 77: start, at most 75, end.

const START = 49406, END = 49407, MAX = 77;

/** GPT-2's mapping of bytes to printable characters, so a word's UTF-8 bytes become vocabulary keys. */
function byteChars(): string[] {
  const keep: number[] = [];
  for (let b = 33; b <= 126; b++) keep.push(b);
  for (let b = 161; b <= 172; b++) keep.push(b);
  for (let b = 174; b <= 255; b++) keep.push(b);
  const out: string[] = new Array(256);
  let n = 0;
  for (let b = 0; b < 256; b++) out[b] = String.fromCharCode(keep.includes(b) ? b : 256 + n++);
  return out;
}

// \p{L} / \p{N} where the JavaScript engine has them, else a close fallback (letters are what changes case)
let letter: (c: string) => boolean, digit: (c: string) => boolean;
try {
  const L = new RegExp("^\\p{L}$", "u"), D = new RegExp("^\\p{N}$", "u");
  letter = (c) => L.test(c); digit = (c) => D.test(c);
} catch {
  letter = (c) => c.toLowerCase() !== c.toUpperCase() || /[ªº぀-ヿ一-鿿가-힯]/.test(c);
  digit = (c) => /[0-9٠-٩²³¹¼-¾]/.test(c);
}
const space = (c: string) => /\s/.test(c);

/** The pre-tokenizer: contractions, runs of letters, single digits, runs of other symbols; spaces dropped. */
export function words(text: string): string[] {
  const s = text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const chars = Array.from(s);
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (space(c)) { i++; continue; }
    if (c === "'") {
      const rest = chars.slice(i + 1, i + 3).join("");
      const m = ["s", "t", "re", "ve", "m", "ll", "d"].find((x) => rest.startsWith(x));
      if (m) { out.push("'" + m); i += 1 + m.length; continue; }
    }
    if (letter(c)) {
      let j = i;
      while (j < chars.length && letter(chars[j])) j++;
      out.push(chars.slice(i, j).join("")); i = j; continue;
    }
    if (digit(c)) { out.push(c); i++; continue; }
    let j = i;
    while (j < chars.length && !space(chars[j]) && !letter(chars[j]) && !digit(chars[j])) j++;
    out.push(chars.slice(i, j).join("")); i = j;
  }
  return out;
}

export class Tokenizer {
  private vocab: Map<string, number>; // a Map: no inherited keys ("constructor") become ids
  private ranks = new Map<string, number>();
  private bytes = byteChars();
  private cache = new Map<string, number[]>();

  constructor(json: { model: { vocab: Record<string, number>; merges: (string | [string, string])[] } }) {
    this.vocab = new Map(Object.entries(json.model.vocab));
    json.model.merges.forEach((m, i) => this.ranks.set(typeof m === "string" ? m : m.join(" "), i));
  }

  private bpe(word: string): number[] {
    const hit = this.cache.get(word);
    if (hit) return hit;
    const chars = Array.from(word);
    let parts = [...chars.slice(0, -1), chars[chars.length - 1] + "</w>"];
    while (parts.length > 1) {
      let best = Infinity, at = -1;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(parts[i] + " " + parts[i + 1]);
        if (r !== undefined && r < best) { best = r; at = i; }
      }
      if (at < 0) break;
      const a = parts[at], b = parts[at + 1], next: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) { next.push(a + b); i++; } else next.push(parts[i]);
      }
      parts = next;
    }
    const ids = parts.map((p) => this.vocab.get(p)).filter((v): v is number => typeof v === "number");
    this.cache.set(word, ids);
    return ids;
  }

  encode(text: string): number[] {
    const enc = new TextEncoder();
    const ids = [START];
    for (const w of words(text)) {
      const mapped = Array.from(enc.encode(w), (b) => this.bytes[b]).join("");
      ids.push(...this.bpe(mapped));
    }
    return [...ids.slice(0, MAX - 1), END];
  }
}
