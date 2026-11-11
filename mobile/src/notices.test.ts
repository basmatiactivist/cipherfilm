import { describe, expect, it } from "vitest";
import { setLang } from "./i18n";
import { lastActive, noticeSummary, noticeText, visibleNotices, type Notice } from "./notices";

describe("notices", () => {
  it("keeps known, well-formed, undismissed notices, newest first", () => {
    const answer = {
      notices: [
        { id: 1, kind: "sign_in", device: "Firefox on Linux", at: 100 },
        { id: 2, kind: "2fa_reset", device: "", at: 300 },
        { id: 3, kind: "something_new", device: "x", at: 400 }, // a later server's kind: not shown
        { id: 6, kind: "password_used", device: "", at: 250 },
        { id: 4, kind: "sign_in", at: 200 }, // no device: still shown
        { id: "5", kind: "sign_in", device: "x", at: 500 },
        null,
      ],
    };
    expect(visibleNotices(answer, new Set()).map((n) => n.id)).toEqual([2, 6, 4, 1]);
    expect(visibleNotices(answer, new Set([2])).map((n) => n.id)).toEqual([6, 4, 1]);
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

  it("says how long ago a device was active", () => {
    setLang("en");
    const now = 1_700_000_000;
    expect(lastActive(now - 30, now)).toBe("Active now");
    expect(lastActive(now - 10 * 60, now)).toBe("10 minutes ago");
    expect(lastActive(now - 3600, now)).toBe("An hour ago");
    expect(lastActive(now - 5 * 3600, now)).toBe("5 hours ago");
    expect(lastActive(now - 10 * 86400, now)).toMatch(/2023/);
  });

  describe("one banner for several", () => {
    const sign = (id: number, at: number, device = "Chrome on macOS"): Notice => ({ id, kind: "sign_in", device, at });

    it("shows nothing for no notices, and one notice as it is", () => {
      setLang("en");
      expect(noticeSummary([])).toBeNull();
      const one = sign(1, 1_700_000_000);
      expect(noticeSummary([one])).toEqual({ text: noticeText(one), open: "devices", ids: [1], many: false });
      expect(noticeSummary([{ id: 2, kind: "2fa_reset", device: "", at: 1 }])?.open).toBe("two-step");
      expect(noticeSummary([{ id: 3, kind: "password_used", device: "", at: 1 }])?.open).toBeNull();
    });

    it("counts several sign-ins in one line, with the newest", () => {
      setLang("en");
      const list = [sign(9, 1_700_000_300, "Chrome on macOS"), sign(8, 1_700_000_200, "Firefox on Linux"), sign(7, 1_700_000_100, "")];
      const s = noticeSummary(list)!;
      expect(s.text).toMatch(/^3 new sign-ins \(latest: Chrome on macOS, .+\)\. Not you\? Review devices\.$/);
      expect(s).toMatchObject({ open: "devices", ids: [9, 8, 7], many: true });
      expect(noticeSummary([sign(2, 2, ""), sign(1, 1)])!.text).toMatch(/latest: an unknown device/);
      setLang("de");
      expect(noticeSummary(list)!.text).toMatch(/^3 neue Anmeldungen \(zuletzt: Chrome on macOS, .+\)\. Nicht Sie\?/);
      setLang("en");
    });

    it("puts the most urgent of mixed kinds first and counts the rest", () => {
      setLang("en");
      const reset: Notice = { id: 5, kind: "2fa_reset", device: "", at: 1_700_000_000 };
      const used: Notice = { id: 6, kind: "password_used", device: "", at: 1_700_000_500 };
      const s = noticeSummary([sign(9, 1_700_000_900), used, reset])!;
      expect(s.text).toMatch(/^An administrator turned off two-step sign-in .* 2 more notices\.$/);
      expect(s).toMatchObject({ open: "two-step", ids: [9, 6, 5], many: true });
      // a password used and a sign-in: the password's sentence, and the devices to look at
      const p = noticeSummary([sign(9, 1_700_000_900), used])!;
      expect(p.text).toMatch(/^Your password was used .* 1 more notice\.$/);
      expect(p.open).toBe("devices");
      expect(noticeSummary([used, { ...used, id: 7 }])!.open).toBeNull();
    });
  });
});
