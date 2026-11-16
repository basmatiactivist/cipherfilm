import type { Item } from "./items";

// Search runs in the browser over the decrypted metadata: the server never sees what anyone searches for.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Everything a search can match for one item, lower-case: name, type, capture date, camera, albums. */
export function haystack(it: Item, albumNames: string[] = []): string {
  const m = it.meta;
  const parts: string[] = [m?.name ?? ""];
  const ext = /\.([a-z0-9]+)$/i.exec(m?.name ?? "")?.[1];
  if (ext) parts.push(ext);
  parts.push(it.kind === "video" ? "video videos movie" : it.kind === "image" ? "photo photos image picture" : "file");
  if (m?.capture_ts) {
    const d = new Date(m.capture_ts);
    const y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
    const mm = String(mo + 1).padStart(2, "0"), dd = String(day).padStart(2, "0");
    parts.push(String(y), MONTHS[mo], `${y}-${mm}`, `${y}-${mm}-${dd}`, `${dd}.${mm}.${y}`, `${day}.${mo + 1}.${y}`);
  }
  if (m?.make) parts.push(m.make);
  if (m?.model) parts.push(m.model);
  if (m?.gps) parts.push("location gps place");
  if (it.favorite) parts.push("favorite favorites favourite heart");
  parts.push(...albumNames);
  return parts.join("\n").toLowerCase();
}

/** Every word of the query has to appear somewhere: "2023 march iphone" narrows to March 2023 iPhone photos. */
export function matches(hay: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => hay.includes(w));
}
