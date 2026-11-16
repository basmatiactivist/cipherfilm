/** The storage and backup overview (server/storage.go): what an account takes, of what kind, and when each of its
 *  devices last uploaded. Only sizes, counts, device labels and times: nothing about what a photo shows. */

export interface StorageSplit { photos: number; videos: number; other: number; thumbs: number; index: number }
export interface StorageDevice {
  id: string; device: string; last_seen: number;
  /** 0: none recorded (the server notes it only since the overview came) */
  last_upload_at: number;
  auto_backup: boolean; backup_stale: boolean; current?: boolean;
}
export interface AccountStorage {
  id: string; email: string; role: string; status: string;
  quota_bytes: number; unlimited: boolean; used_bytes: number; item_count: number;
  split: StorageSplit; devices: StorageDevice[];
  /** a public demo account: the strangers sharing it are not listed */
  devices_hidden?: boolean;
}
export interface ServerStorage {
  accounts: AccountStorage[]; used_bytes: number; item_count: number; stale_devices: number;
  disk_free_bytes: number; disk_total_bytes: number;
}

export const SPLIT_LABELS: [keyof StorageSplit, string][] = [
  ["photos", "Photos"], ["videos", "Videos"], ["other", "Other files"], ["thumbs", "Thumbnails and previews"], ["index", "Search and settings"],
];

/** The non-empty parts of an account's storage, in a fixed order, with their percentage of
 *  the whole (rounded; a part that is there shows at least 1 %). */
export function splitParts(split: StorageSplit): { key: keyof StorageSplit; label: string; bytes: number; pct: number }[] {
  const total = SPLIT_LABELS.reduce((n, [k]) => n + Math.max(0, split[k] || 0), 0);
  if (total <= 0) return [];
  return SPLIT_LABELS.filter(([k]) => (split[k] || 0) > 0).map(([key, label]) => ({
    key, label, bytes: split[key], pct: Math.max(1, Math.round((split[key] / total) * 100)),
  }));
}

/** How full an account is, 0–100, or null when it has no limit. */
export function quotaPct(a: Pick<AccountStorage, "unlimited" | "quota_bytes" | "used_bytes">): number | null {
  if (a.unlimited || a.quota_bytes <= 0) return null;
  return Math.min(100, Math.round((a.used_bytes / a.quota_bytes) * 100));
}

export const daysSince = (sec: number, now = Date.now() / 1000) => Math.max(0, Math.floor((now - sec) / 86400));

/** "Last upload today", "… 3 days ago", or that none is recorded. */
export function lastUploadText(d: Pick<StorageDevice, "last_upload_at">, now = Date.now() / 1000): string {
  if (!d.last_upload_at) return "No upload recorded yet";
  const n = daysSince(d.last_upload_at, now);
  return n === 0 ? "Last upload today" : n === 1 ? "Last upload yesterday" : `Last upload ${n} days ago`;
}

/** The hint for a phone whose automatic backup seems to have stopped; "" when it doesn't. */
export function staleText(d: StorageDevice, now = Date.now() / 1000): string {
  if (!d.backup_stale) return "";
  return `No uploads for ${daysSince(d.last_upload_at, now)} days although this phone is in use. Automatic backup may be off or stuck: open the app on it and check Backup.`;
}

export const staleCount = (accounts: AccountStorage[]) => accounts.reduce((n, a) => n + a.devices.filter((d) => d.backup_stale).length, 0);
