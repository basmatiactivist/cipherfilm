import { describe, expect, it, vi } from "vitest";

vi.mock("expo-asset", () => ({ Asset: { fromModule: () => ({}) } }));
vi.mock("expo-file-system", () => ({ File: class { get exists() { return false; } }, Paths: { document: "/doc" } }));
vi.mock("./session", () => ({ onWipe: () => {} }));

const { findTrips } = await import("@memories/trips");
const { tripTitle } = await import("./trips");
const { setLang } = await import("./i18n");
const { PRIVATE } = await import("./privateRoutes");
import type { Item } from "./library";

const at = (id: string, lat: number, lon: number, m: number, d: number): Item => ({
  id, kind: "image", size: 1, segment_count: 1, created_at: 0, has_thumb: true, has_preview: true,
  meta: { name: `${id}.jpg`, mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: new Date(2025, m - 1, d, 12).getTime(), gps: { lat, lon } },
});
const home = Array.from({ length: 6 }, (_, i) => at(`h${i}`, 47.3769, 8.5417, 3, 1 + i * 3));
const rome = [10, 10, 11, 11, 12].map((d, i) => at(`r${i}`, 41.9028, 12.4964, 5, d));
const lookup = () => ({ place: { name: "Rome", region: "Lazio" }, country: "Italien", countryCode: "IT" });

describe("trips on the phone", () => {
  it("uses the shared rules with the app's items and names them in the app's language", () => {
    const trips = findTrips([...home, ...rome], lookup);
    expect(trips.map((x) => x.items.map((i) => i.id))).toEqual([rome.map((i) => i.id)]);
    setLang("de");
    expect(tripTitle(trips[0])).toBe("Rome, Mai 2025");
    const two = { ...trips[0], where: { kind: "countries" as const, countries: [{ country: "Italien", countryCode: "IT" }, { country: "Frankreich", countryCode: "FR" }] } };
    expect(tripTitle(two)).toBe("Italien und Frankreich, Mai 2025");
    setLang("en");
    expect(tripTitle(trips[0])).toBe("Rome, May 2025");
  });

  it("closes the trip and recap screens at a lock", () => {
    expect(PRIVATE.has("trip")).toBe(true);
    expect(PRIVATE.has("recap")).toBe(true);
  });
});
