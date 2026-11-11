// The "On this day" row at the top of the timeline: one card per earlier year (memories.ts). A card opens that
// year's photos in the viewer.
import type { Item } from "../items";
import { Tile } from "../grid";
import type { Memory } from "./memories";

const fmtDate = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });
export const yearsAgo = (n: number) => (n === 1 ? "1 year ago" : `${n} years ago`);

export function MemoriesRow(p: { memories: Memory<Item>[]; onOpen: (m: Memory<Item>) => void }) {
  if (!p.memories.length) return null;
  return (
    <section class="memories" aria-labelledby="memhead">
      <h2 class="memhead" id="memhead">On this day</h2>
      <ul class="memrow">
        {p.memories.map((m) => {
          const date = fmtDate.format(m.date);
          const count = m.total === 1 ? "1 item" : `${m.total} items`;
          return (
            <li key={m.year}>
              <button class="memcard" onClick={() => p.onOpen(m)} aria-label={`${yearsAgo(m.yearsAgo)}, ${date}, ${count}`}>
                <span class="cover"><Tile plain item={m.cover} selectMode={false} selected={false} onOpen={() => {}} onToggle={() => {}} /></span>
                <span class="memago">{yearsAgo(m.yearsAgo)}</span>
                <span class="small">{date}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
