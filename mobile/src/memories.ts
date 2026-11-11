// "On this day" (memories): the photos taken around today's date in earlier years, found on the phone from the
// decrypted capture dates by the rules the web app uses (web/src/memories/memories.ts, shared through @memories).
// Nothing about it goes to the server. On by default; Account › Memories turns it off. The setting is this phone's,
// kept in the app's private files.
import { useMemo, useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";
import { findMemories, todayKey, type Memory } from "@memories/memories";
import type { Item } from "./library";
import { t } from "./i18n";

export type { Memory };

const FILE = () => new File(Paths.document, "memories.json");

let on = true;
try { const f = FILE(); if (f.exists) on = JSON.parse(f.textSync()).on !== false; } catch { /* default */ }
const subs = new Set<() => void>();

export const memoriesOn = () => on;
export const useMemoriesOn = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => on);

export function setMemoriesOn(v: boolean) {
  on = v;
  FILE().write(JSON.stringify({ on: v })).catch(() => { /* stays for this run */ });
  subs.forEach((f) => f());
}

/** The memories for today, worked out again when the library, the setting or the day changes. */
export function useMemories(items: Item[] | null): Memory<Item>[] {
  const enabled = useMemoriesOn();
  const day = todayKey();
  return useMemo(() => (enabled && items ? findMemories(items) : []), [items, enabled, day]);
}

/** "3 years ago", "1 year ago" in the app's language. */
export const yearsAgo = (n: number): string => (n === 1 ? t("1 year ago") : t("{n} years ago", { n }));
