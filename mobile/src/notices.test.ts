import { describe, expect, it } from "vitest";
import { setLang } from "./i18n";
import { deviceLabel, lastActive, noticeOpens, noticeText, unreadCount, visibleNotices, type Notice } from "./notices";

describe("notices", () => {
  it("keeps known, well-formed, undismissed notices, newest first", () => {
    const answer = {
      notices: [
        { id: 1, kind: "sign_in", device: "Firefox on Linux", at: 100 },
        { id: 2, kind: "2fa_reset", device: "", at: 300 },
        { id: 3, kind: "something_new", device: "x", at: 400 }, // a later server's kind: not shown
        { id: 6, kind: "password_used", device: "", at: 250 },
        { id: 4, kind: "sign_in", at: 200 }, // no device: still shown
        { id: 7, kind: "passkey_added", device: "Pixel 8 (Android app)", at: 260 },
        { id: 8, kind: "2fa_off", device: "", at: 270 },
        { id: "5", kind: "sign_in", device: "x", at: 500 },
        null,
      ],
    };
    expect(visibleNotices(answer, new Set()).map((n) => n.id)).toEqual([2, 8, 7, 6, 4, 1]);
    expect(visibleNotices(answer, new Set([2])).map((n) => n.id)).toEqual([8, 7, 6, 4, 1]);
    expect(visibleNotices({}, new Set())).toEqual([]);
    expect(visibleNotices(null, new Set())).toEqual([]);
  });

  it("words them", () => {
    setLang("en");
    expect(noticeText({ id: 1, kind: "sign_in", device: "Pixel 8 (Android app)", at: 1_700_000_000 })).toMatch(/^New sign-in: Pixel 8 \(Android app\), .+\. Not you\? Review devices\.$/);
    expect(noticeText({ id: 1, kind: "sign_in", device: "", at: 1_700_000_000 })).toMatch(/an unknown device/);
    expect(noticeText({ id: 2, kind: "2fa_reset", device: "", at: 1_700_000_000 })).toMatch(/^An administrator turned off two-step sign-in/);
    expect(noticeText({ id: 3, kind: "password_used", device: "", at: 1_700_000_000 })).toMatch(/^Your password was used to start a sign-in that wasn't finished \(.+\)\. Not you\? Change your password/);
    setLang("de");
    expect(noticeText({ id: 1, kind: "sign_in", device: "Mac", at: 1_700_000_000 })).toMatch(/^Neue Anmeldung: Mac, /);
    expect(noticeText({ id: 3, kind: "password_used", device: "", at: 1_700_000_000 })).toMatch(/^Mit Ihrem Passwort wurde eine Anmeldung begonnen/);
    setLang("en");
  });

  it("words changes to two-step sign-in made on another device", () => {
    setLang("en");
    const at = 1_700_000_000;
    const w = (kind: Notice["kind"], device = "Firefox on Linux") => noticeText({ id: 1, kind, device, at });
    expect(w("totp_added")).toMatch(/^An authenticator app was added to two-step sign-in on Firefox on Linux, .+\. Not you\?$/);
    expect(w("totp_removed")).toMatch(/^The authenticator app was removed from two-step sign-in on Firefox on Linux, .+\. Not you\?$/);
    expect(w("passkey_added")).toMatch(/^A passkey was added to two-step sign-in on Firefox on Linux, /);
    expect(w("passkey_removed")).toMatch(/^A passkey was removed from two-step sign-in on Firefox on Linux, /);
    expect(w("recovery_codes")).toMatch(/^New recovery codes were made on Firefox on Linux, .+; the old ones no longer work\. Not you\?$/);
    expect(w("2fa_off")).toMatch(/^Two-step sign-in was turned off on Firefox on Linux, .+\. Not you\?$/);
    expect(w("2fa_off", "")).toMatch(/turned off on an unknown device, /);
    setLang("de");
    expect(w("passkey_added")).toMatch(/^Ein Passkey wurde zur Anmeldung in zwei Schritten hinzugefügt: Firefox auf Linux, /);
    expect(w("recovery_codes", "")).toMatch(/^Neue Wiederherstellungscodes wurden erstellt: ein unbekanntes Gerät, /);
    setLang("en");
    for (const kind of ["totp_added", "totp_removed", "passkey_added", "passkey_removed", "recovery_codes", "2fa_off"] as const) {
      expect(noticeOpens(kind)).toBe("two-step");
    }
  });

  it("says how long ago a device was active", () => {
    setLang("en");
    const now = 1_700_000_000;
    expect(lastActive(now - 30, now)).toBe("Active now");
    expect(lastActive(now - 10 * 60, now)).toBe("10 minutes ago");
    expect(lastActive(now - 3600, now)).toBe("An hour ago");
    expect(lastActive(now - 5 * 3600, now)).toBe("5 hours ago");
    expect(lastActive(now - 10 * 86400, now)).toMatch(/2023/);
  });

  it("words the server's device labels in the phone's language", () => {
    setLang("de");
    expect(deviceLabel("Chrome on macOS")).toBe("Chrome auf macOS");
    expect(deviceLabel("OPPO CPH2791 (Android app)")).toBe("OPPO CPH2791 (Android-App)");
    expect(deviceLabel("Upload tool")).toBe("Upload-Programm");
    expect(deviceLabel("Something else")).toBe("Something else");
    setLang("en");
    expect(deviceLabel("Chrome on macOS")).toBe("Chrome on macOS");
  });

  it("says where each one leads, and how many are unread", () => {
    expect(noticeOpens("sign_in")).toBe("devices");
    expect(noticeOpens("2fa_reset")).toBe("two-step");
    expect(noticeOpens("password_used")).toBeNull();
    const list: Notice[] = [3, 2, 1].map((id) => ({ id, kind: "sign_in", device: "", at: id }));
    expect(unreadCount(list, 0)).toBe(3);
    expect(unreadCount(list, 2)).toBe(1);
    expect(unreadCount(list, 3)).toBe(0);
    expect(unreadCount([], 0)).toBe(0);
  });
});
