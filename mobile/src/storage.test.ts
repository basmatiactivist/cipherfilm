import { beforeEach, describe, expect, it, vi } from "vitest";

// The storage and backup overview: the requests (server/storage.go) and the wording. The server is a stand-in.
const st = vi.hoisted(() => ({ calls: [] as { method: string; path: string }[], reply: (): unknown => ({}) }));
vi.mock("./api", () => ({
  api: async (method: string, path: string) => { st.calls.push({ method, path }); return st.reply(); },
  server: () => "https://photos.example.test/",
}));

const s = await import("./storage");
const { loadStorage } = await import("./admin");
const { setLang } = await import("./i18n");
const NOW = 1_800_000_000;
const DAY = 86400;
const split = (o: Partial<import("./storage").StorageSplit> = {}) => ({ photos: 0, videos: 0, other: 0, thumbs: 0, index: 0, ...o });
const account = (o: Partial<import("./storage").AccountStorage> = {}): import("./storage").AccountStorage => ({
  id: "a", email: "a@x.test", role: "user", status: "active", quota_bytes: 10e9, unlimited: false, used_bytes: 2.5e9,
  item_count: 3, split: split(), devices: [], ...o,
});

describe("storage overview", () => {
  beforeEach(() => { st.calls = []; setLang("en"); });

  it("asks the server's two endpoints", async () => {
    await s.loadMyStorage();
    await loadStorage();
    expect(st.calls).toEqual([{ method: "GET", path: "/api/me/storage" }, { method: "GET", path: "/api/admin/storage" }]);
  });

  it("fills the bar against the limit, none without one", () => {
    expect(s.usedShare(account())).toBe(0.25);
    expect(s.usedShare(account({ used_bytes: 20e9 }))).toBe(1);
    expect(s.usedShare(account({ unlimited: true, quota_bytes: 0 }))).toBeNull();
    expect(s.storageLine(account())).toBe("2.5 GB of 10.0 GB · 3 items");
    expect(s.storageLine(account({ unlimited: true, quota_bytes: 0, item_count: 1 }))).toBe("2.5 GB used, no limit · 1 item");
  });

  it("lists only the parts that take space, in a fixed order", () => {
    const parts = s.splitParts(split({ index: 2e6, photos: 1.5e9, thumbs: 300e6 }));
    expect(parts.map((p) => p.key)).toEqual(["photos", "thumbs", "index"]);
    expect(parts.map((p) => `${p.label}: ${p.text}`)).toEqual(["Photos: 1.5 GB", "Thumbnails and previews: 300 MB", "Search index and settings: 2 MB"]);
    expect(s.splitParts(split())).toEqual([]);
    setLang("de");
    expect(s.splitParts(split({ videos: 1, other: 2e9 })).map((p) => p.label)).toEqual(["Videos", "Sonstiges"]);
  });

  it("says when a device last uploaded", () => {
    expect(s.daysSince(NOW - 3 * DAY - 5, NOW)).toBe(3);
    expect(s.daysSince(NOW + 100, NOW)).toBe(0);
    expect(s.lastUploadText({ last_upload_at: 0 }, NOW)).toBe("No upload recorded yet");
    expect(s.lastUploadText({ last_upload_at: NOW - 60 }, NOW)).toBe("Last upload today");
    expect(s.lastUploadText({ last_upload_at: NOW - DAY - 60 }, NOW)).toBe("Last upload yesterday");
    expect(s.lastUploadText({ last_upload_at: NOW - 9 * DAY }, NOW)).toBe("Last upload 9 days ago");
    setLang("de");
    expect(s.lastUploadText({ last_upload_at: 0 }, NOW)).toBe("Noch kein Upload erfasst");
  });

  it("warns only for a phone the server marked stale", () => {
    expect(s.staleText({ backup_stale: false, last_upload_at: NOW - 30 * DAY }, NOW)).toBeUndefined();
    expect(s.staleText({ backup_stale: true, last_upload_at: NOW - 12 * DAY }, NOW))
      .toBe("No uploads for 12 days although this phone is in use. Automatic backup may be off or stuck.");
    expect(s.staleSummary(0)).toBeUndefined();
    expect(s.staleSummary(1)).toBe("1 phone seems to have stopped backing up.");
    expect(s.staleSummary(2)).toBe("2 phones seem to have stopped backing up.");
  });

  it("names devices as the device list does, and totals the server", () => {
    expect(s.deviceName({ device: "Pixel 8 (Android app)" })).toBe("Pixel 8 (Android app)");
    expect(s.deviceName({ device: "" })).toBe("Unknown device");
    expect(s.totalLine({ used_bytes: 12e9, item_count: 4000 })).toBe("12.0 GB stored · 4,000 items");
    expect(s.diskShare({ disk_free_bytes: 25, disk_total_bytes: 100 })).toBe(0.75);
    expect(s.diskShare({ disk_free_bytes: 0, disk_total_bytes: 0 })).toBeNull();
  });
});
