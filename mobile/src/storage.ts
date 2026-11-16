// The storage and backup overview (Account and Administration › Storage; server/storage.go): how much an account
// takes and of what kind, and per signed-in device when it last uploaded. Only sizes, counts, device labels and times:
// the server knows nothing more (what a photo shows, its name, date or place are encrypted). No React Native here:
// the requests and the wording, tested on their own (storage.test.ts).
import { api } from "./api";
import { t, tn } from "./i18n";
import { size, usageLine } from "./admin";
import { deviceLabel, lastActive } from "./notices";

export interface StorageSplit { photos: number; videos: number; other: number; thumbs: number; index: number }
export interface StorageDevice {
  id: string; device: string; last_seen: number;
  /** the server gave only the day the device was last used (another person's device in Administration): last_seen is
   *  that day's midnight, UTC */
  last_seen_day_only?: boolean;
  /** 0: none recorded yet (the server notes it only since the overview came) */
  last_upload_at: number;
  /** a phone app that backs up on its own */
  auto_backup: boolean;
  /** the phone is in use, but hasn't uploaded for more than 7 days */
  backup_stale: boolean;
  current?: boolean;
}
export interface AccountStorage {
  id: string; email: string; role: string; status: string; quota_bytes: number; unlimited: boolean; used_bytes: number;
  item_count: number; split: StorageSplit; devices: StorageDevice[];
  /** the public demo account: strangers' devices are never listed */
  devices_hidden?: boolean;
}
export interface ServerStorage {
  accounts: AccountStorage[]; used_bytes: number; item_count: number; stale_devices: number;
  disk_free_bytes: number; disk_total_bytes: number;
}

/** The person's own overview (any signed-in account). */
export const loadMyStorage = () => api<AccountStorage>("GET", "/api/me/storage");

/** Used of the limit, 0 to 1; null without a limit (nothing to fill a bar against). */
export const usedShare = (a: Pick<AccountStorage, "used_bytes" | "quota_bytes" | "unlimited">): number | null =>
  (a.unlimited || a.quota_bytes <= 0 ? null : Math.min(1, Math.max(0, a.used_bytes / a.quota_bytes)));

/** "1.2 GB of 5.0 GB · 120 items", or "… used, no limit" (the same line as Administration's people list). */
export const storageLine = (a: AccountStorage): string => usageLine({ ...a, quota_bytes: a.unlimited ? 0 : a.quota_bytes });

/** What the space is taken by, in a fixed order, only the parts that take any. */
export function splitParts(s: StorageSplit): { key: keyof StorageSplit; label: string; bytes: number; text: string }[] {
  const parts: [keyof StorageSplit, string][] = [
    ["photos", t("Photos")], ["videos", t("Videos")], ["other", t("storage|Other")],
    ["thumbs", t("Thumbnails and previews")], ["index", t("Search index and settings")],
  ];
  return parts.filter(([k]) => (s[k] ?? 0) > 0).map(([key, label]) => ({ key, label, bytes: s[key], text: size(s[key]) }));
}

/** Whole days since a time (0 = less than a day ago). */
export const daysSince = (sec: number, now = Date.now() / 1000): number => Math.max(0, Math.floor((now - sec) / 86400));

/** When a device was last used: minutes or hours when the server gives the time, else today, yesterday or days ago. */
export function lastSeenText(d: Pick<StorageDevice, "last_seen" | "last_seen_day_only">, now = Date.now() / 1000): string {
  if (!d.last_seen_day_only) return lastActive(d.last_seen, now);
  const n = Math.max(0, Math.floor(now / 86400) - Math.floor(d.last_seen / 86400));
  return n === 0 ? t("active today") : n === 1 ? t("active yesterday") : t("active {n} days ago", { n });
}

/** When a device last uploaded. */
export function lastUploadText(d: Pick<StorageDevice, "last_upload_at">, now = Date.now() / 1000): string {
  if (!d.last_upload_at) return t("No upload recorded yet");
  const n = daysSince(d.last_upload_at, now);
  return n === 0 ? t("Last upload today") : n === 1 ? t("Last upload yesterday") : t("Last upload {n} days ago", { n });
}

/** The warning for a phone whose automatic backup seems to have stopped; undefined when there's nothing to say. */
export function staleText(d: Pick<StorageDevice, "last_upload_at" | "backup_stale">, now = Date.now() / 1000): string | undefined {
  if (!d.backup_stale) return undefined;
  return t("No uploads for {n} days although this phone is in use. Automatic backup may be off or stuck.", { n: daysSince(d.last_upload_at, now) });
}

/** A device's name as the device list shows it. */
export const deviceName = (d: Pick<StorageDevice, "device">): string => (d.device ? deviceLabel(d.device) : t("Unknown device"));

/** The admin overview's top line: "12.0 GB stored · 4,000 items". */
export const totalLine = (s: Pick<ServerStorage, "used_bytes" | "item_count">): string =>
  t("{stored} stored · {items}", { stored: size(s.used_bytes), items: tn(s.item_count, "{n} item", "{n} items") });

/** The admin overview's warning when phones seem to have stopped backing up. */
export const staleSummary = (n: number): string | undefined =>
  (n > 0 ? tn(n, "{n} phone seems to have stopped backing up.", "{n} phones seem to have stopped backing up.") : undefined);

/** The disk the server stores on: used share for the bar, null when it couldn't be read. */
export const diskShare = (s: Pick<ServerStorage, "disk_free_bytes" | "disk_total_bytes">): number | null =>
  (s.disk_total_bytes > 0 ? Math.min(1, Math.max(0, (s.disk_total_bytes - s.disk_free_bytes) / s.disk_total_bytes)) : null);

/** Devices shown before "Show all": this phone, any whose backup seems stuck, then the most recent uploaders. */
export const DEVICES_SHOWN = 3;
/** The devices to show folded (DEVICES_SHOWN at most, the important ones first) and how many are left out. */
export function foldDevices<D extends Pick<StorageDevice, "last_seen" | "last_upload_at" | "backup_stale" | "current">>(devices: readonly D[], open: boolean): { shown: D[]; hidden: number } {
  if (open || devices.length <= DEVICES_SHOWN) return { shown: [...devices], hidden: 0 };
  const rank = (d: D) => (d.current ? 0 : d.backup_stale ? 1 : d.last_upload_at > 0 ? 2 : 3);
  const order = [...devices].sort((a, b) => rank(a) - rank(b) || b.last_upload_at - a.last_upload_at || b.last_seen - a.last_seen);
  const shown = order.slice(0, Math.max(DEVICES_SHOWN, order.filter((d) => rank(d) <= 1).length));
  return { shown: devices.filter((d) => shown.includes(d)), hidden: devices.length - shown.length };
}
