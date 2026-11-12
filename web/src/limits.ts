// Admin numbers as people read and type them: storage limits in GB with one decimal, and how long the server runs.

/** A limit in bytes as the GB field shows it: one decimal, without a trailing ".0" ("21.5", "20", "0"). */
export function gbText(bytes: number): string {
  if (!(bytes > 0)) return "0";
  const v = Math.round(bytes / 1e8) / 10;
  return v === 0 ? "0.1" : String(v);
}

/** What the field holds, in bytes; null when it isn't a number of GB (0 or more). A comma works as the decimal mark.
 *  The field unchanged gives back the exact limit it was filled from (from), so saving it never shrinks the limit. */
export function gbBytes(text: string, from?: number): number | null {
  const t = text.trim();
  if (from !== undefined && t === gbText(from)) return from;
  if (!/^\d*(?:[.,]\d*)?$/.test(t) || !/\d/.test(t)) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e9) : null;
}

const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** How long the server has been running: "1 day", "3 hours", "1 minute". */
export function uptimeText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400) return unit(Math.floor(s / 86400), "day");
  if (s >= 3600) return unit(Math.floor(s / 3600), "hour");
  return s < 60 ? "less than a minute" : unit(Math.floor(s / 60), "minute");
}
