/** File names inside ZIPs and download headers. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function safeName(n: unknown): string {
  // control characters, bidirectional marks and overrides (they can make "photo\u202Egpj.exe" read as a picture),
  // invisible zero-width characters and path characters; trailing dots and spaces again after the cut to 200
  let cleaned = (typeof n === "string" ? n : "")
    .replace(/[\u0000-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "").replace(/[. ]+$/, "").trim().slice(0, 200).replace(/[. ]+$/, "");
  if (RESERVED.test(cleaned)) cleaned = "_" + cleaned; // Windows device names
  return cleaned || "file";
}

/** Makes names unique within one archive: a.jpg, a (1).jpg, a (2).jpg … (case-insensitive, like most file systems). */
export function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((raw) => {
    const name = safeName(raw);
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let out = name, i = 0;
    while (seen.has(out.toLowerCase())) out = `${stem} (${++i})${ext}`;
    seen.add(out.toLowerCase());
    return out;
  });
}

/** Content-Disposition for an attachment, with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function attachment(name: string): string {
  const n = safeName(name);
  const ascii = n.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(n).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
