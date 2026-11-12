import { describe, expect, it } from "vitest";
import { setLang } from "./i18n";
import type { Notice } from "./notices";
import { KEEP, RECENT, alertId, alertText, plan, readSeen, remember } from "./noticeAlerts";

const NOW = 1_800_000_000;
const n = (id: number, at = NOW - 60, kind: Notice["kind"] = "sign_in", device = "Pixel 8 (Android app)"): Notice => ({ id, kind, device, at });
const S = "https://photos.example";

describe("which notices become notifications", () => {
  it("shows each new one once, oldest first, never one already seen", () => {
    const p = plan([n(3, NOW - 10), n(2, NOW - 100)], null, S, NOW, false);
    expect(p.show.map((x) => x.id)).toEqual([2, 3]);
    expect(p.quiet).toEqual([]);
    const seen = remember(null, S, [2, 3]);
    expect(plan([n(4), n(3), n(2)], seen, S, NOW, false).show.map((x) => x.id)).toEqual([4]);
    expect(plan([n(3), n(2)], seen, S, NOW, false).show).toEqual([]);
  });

  it("shows nothing while the app is on screen (the banner does), and marks those seen", () => {
    const p = plan([n(5), n(4)], remember(null, S, [4]), S, NOW, true);
    expect(p.show).toEqual([]);
    expect(p.quiet).toEqual([5]);
  });

  it("only marks old ones seen: a phone that was off for days doesn't get a pile", () => {
    const p = plan([n(9, NOW - 60), n(8, NOW - RECENT - 1, "2fa_reset", "")], null, S, NOW, false);
    expect(p.show.map((x) => x.id)).toEqual([9]);
    expect(p.quiet).toEqual([8]);
  });

  it("takes down the notification of one dismissed meanwhile, not of one only pushed out of the server's 20", () => {
    const seen = remember(null, S, [1, 2, 30]);
    expect(plan([n(30)], seen, S, NOW, false).cancel.sort()).toEqual([1, 2]);
    const twenty = Array.from({ length: 20 }, (_, i) => n(11 + i));
    expect(plan(twenty, seen, S, NOW, false).cancel).toEqual([]);
  });

  it("starts over for another server (its ids are its own)", () => {
    const seen = remember(null, "https://other.example", [7]);
    expect(plan([n(7)], seen, S, NOW, false).show.map((x) => x.id)).toEqual([7]);
    expect(remember(seen, S, [8])).toEqual({ server: S, ids: [8] });
  });

  it("keeps the newest ids and reads only a well-formed list", () => {
    const many = remember(null, S, Array.from({ length: KEEP + 50 }, (_, i) => i + 1));
    expect(many.ids.length).toBe(KEEP);
    expect(many.ids[0]).toBe(KEEP + 50);
    expect(readSeen({ server: S, ids: [1, "2", 3] })).toEqual({ server: S, ids: [1, 3] });
    expect(readSeen({ ids: [1] })).toBeNull();
    expect(readSeen(null)).toBeNull();
  });

  it("says on the lock screen only that something happened, the rest as the banner does", () => {
    setLang("en");
    const w = alertText(n(1, NOW, "sign_in", "Thief's phone"));
    expect(w.publicTitle).toBe("New sign-in to Cipherfilm");
    expect(w.publicTitle).not.toContain("Thief");
    expect(w.title).toBe("New sign-in");
    expect(w.text).toMatch(/^New sign-in: Thief's phone, .+\. Not you\? Review devices\.$/);
    expect(alertText(n(2, NOW, "2fa_reset", "")).publicTitle).toBe("Security notice from Cipherfilm");
    expect(alertText(n(3, NOW, "password_used", "")).title).toBe("Unfinished sign-in");
    // changes to two-step sign-in on another device: the lock screen names neither the device nor the change
    for (const kind of ["totp_added", "totp_removed", "passkey_added", "passkey_removed", "recovery_codes", "2fa_off"] as const) {
      const a = alertText(n(4, NOW, kind, "Thief's phone"));
      expect(a.publicTitle).toBe("Security notice from Cipherfilm");
      expect(a.text).toContain("Thief's phone");
    }
    expect(alertText(n(4, NOW, "passkey_added", "x")).title).toBe("Two-step sign-in changed");
    expect(alertText(n(4, NOW, "recovery_codes", "x")).text).toMatch(/^New recovery codes were made on x, /);
    expect(alertText(n(5, NOW, "2fa_off", "x")).title).toBe("Two-step sign-in turned off");
    setLang("de");
    expect(alertText(n(1)).publicTitle).toBe("Neue Anmeldung bei Cipherfilm");
    expect(alertText(n(4, NOW, "totp_removed", "x")).title).toBe("Anmeldung in zwei Schritten geändert");
    expect(alertText(n(4, NOW, "totp_removed", "x")).publicTitle).toBe("Sicherheitshinweis von Cipherfilm");
    setLang("en");
    expect(alertId(5)).toBe(5);
    expect(alertId(2 ** 31 + 4)).toBeLessThan(2 ** 31);
  });
});

describe("the notification on the lock screen", () => {
  it("is secret (not private), so the phone's show-all-content setting can't reveal device and time", async () => {
    // @ts-ignore: runs in Node (vitest), where the app's types have no node:fs
    const { readFileSync } = await import("node:fs");
    const kt: string = readFileSync(new URL("../modules/cf-native/android/src/main/java/app/cipherfilm/cfnative/Notices.kt", import.meta.url), "utf8");
    expect(kt).toContain("lockscreenVisibility = NotificationCompat.VISIBILITY_SECRET");
    expect(kt).toContain(".setVisibility(NotificationCompat.VISIBILITY_SECRET)");
    expect(kt).not.toContain("VISIBILITY_PRIVATE");
    expect(kt).toContain(".setPublicVersion(public)");
  });
});
