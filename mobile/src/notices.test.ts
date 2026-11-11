import { describe, expect, it } from "vitest";
import { setLang } from "./i18n";
import { lastActive, noticeText, visibleNotices } from "./notices";

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
});
