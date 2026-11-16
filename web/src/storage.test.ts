import { describe, expect, it } from "vitest";
import { AccountStorage, StorageDevice, lastUploadText, quotaPct, splitParts, staleCount, staleText } from "./storage";

const now = 1_800_000_000;
const day = 86400;
const dev = (x: Partial<StorageDevice>): StorageDevice => ({ id: "a", device: "Phone (Android app)", last_seen: now, last_upload_at: 0, auto_backup: true, backup_stale: false, ...x });

describe("storage overview", () => {
  it("splits into the parts that are there, with shares", () => {
    const parts = splitParts({ photos: 750, videos: 200, other: 0, thumbs: 49, index: 1 });
    expect(parts.map((p) => p.key)).toEqual(["photos", "videos", "thumbs", "index"]);
    expect(parts.map((p) => p.pct)).toEqual([75, 20, 5, 1]);
    expect(splitParts({ photos: 0, videos: 0, other: 0, thumbs: 0, index: 0 })).toEqual([]);
  });

  it("shows how full an account is, or nothing without a limit", () => {
    expect(quotaPct({ unlimited: false, quota_bytes: 1000, used_bytes: 250 })).toBe(25);
    expect(quotaPct({ unlimited: false, quota_bytes: 1000, used_bytes: 5000 })).toBe(100);
    expect(quotaPct({ unlimited: true, quota_bytes: 0, used_bytes: 5000 })).toBeNull();
  });

  it("says when a device last uploaded", () => {
    expect(lastUploadText(dev({}), now)).toBe("No upload recorded yet");
    expect(lastUploadText(dev({ last_upload_at: now - 60 }), now)).toBe("Last upload today");
    expect(lastUploadText(dev({ last_upload_at: now - day - 60 }), now)).toBe("Last upload yesterday");
    expect(lastUploadText(dev({ last_upload_at: now - 9 * day }), now)).toBe("Last upload 9 days ago");
  });

  it("warns only for a phone the server flags", () => {
    expect(staleText(dev({ last_upload_at: now - 9 * day }), now)).toBe("");
    expect(staleText(dev({ last_upload_at: now - 9 * day, backup_stale: true }), now)).toMatch(/^No uploads for 9 days/);
    const acc = (devices: StorageDevice[]) => ({ devices }) as AccountStorage;
    expect(staleCount([acc([dev({ backup_stale: true }), dev({})]), acc([dev({ backup_stale: true })]), acc([])])).toBe(2);
  });
});
