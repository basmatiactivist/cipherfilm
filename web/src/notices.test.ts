import { describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ dismissed: [] as string[], list: [] as unknown[] }));
vi.mock("./api", () => ({
  api: async (method: string, path: string) => {
    if (method === "GET" && path === "/api/me/notices") return { notices: sent.list };
    if (method === "POST") { sent.dismissed.push(path); return { ok: true }; }
    throw new Error(path);
  },
}));
import { loadNotices, type Notice, noticeAction, noticeText, usable } from "./notices";

describe("notices", () => {
  it("keeps known kinds only, newest first, without the dismissed", () => {
    const raw = { notices: [
      { id: 1, kind: "sign_in", device: "Pixel 8 (Android app)", at: 100 },
      { id: 2, kind: "2fa_reset", device: "", at: 300 },
      { id: 3, kind: "something_new", device: "", at: 400 },
      { id: 6, kind: "password_used", device: "", at: 250 },
      { id: 4, kind: "sign_in", at: 200 },
      { id: 9, kind: "passkey_added", device: "Firefox on Linux", at: 260 },
      { id: "5", kind: "sign_in", at: 500 },
      null,
    ] };
    expect(usable(raw).map((n) => n.id)).toEqual([2, 9, 6, 4, 1]);
    expect(usable(raw, new Set([2])).map((n) => n.id)).toEqual([9, 6, 4, 1]);
    expect(usable(raw)[3].device).toBe("");
    expect(usable({})).toEqual([]);
    expect(usable(null)).toEqual([]);
  });
  it("says what happened", () => {
    expect(noticeText({ id: 1, kind: "sign_in", device: "Firefox on Windows", at: 1_700_000_000 })).toMatch(/^New sign-in: Firefox on Windows, .+\. Not you\?$/);
    expect(noticeText({ id: 1, kind: "sign_in", device: "", at: 1_700_000_000 })).toContain("an unknown device");
    expect(noticeText({ id: 2, kind: "2fa_reset", device: "", at: 1_700_000_000 })).toMatch(/^An administrator turned off two-step sign-in/);
    expect(noticeText({ id: 3, kind: "password_used", device: "", at: 1_700_000_000 })).toMatch(/^Your password was used to start a sign-in that wasn't finished \(.+\)\. Not you\?$/);
  });
  it("says what changed in two-step sign-in, and where", () => {
    const t = (kind: string, device = "Pixel 8 (Android app)") => noticeText({ id: 1, kind: kind as Notice["kind"], device, at: 1_700_000_000 });
    expect(t("totp_added")).toMatch(/^An authenticator app was added to two-step sign-in on Pixel 8 \(Android app\), .+\. Not you\?$/);
    expect(t("totp_removed")).toMatch(/^The authenticator app was removed from two-step sign-in on Pixel 8 \(Android app\), .+\. Not you\?$/);
    expect(t("passkey_added")).toMatch(/^A passkey was added to two-step sign-in on Pixel 8/);
    expect(t("passkey_removed")).toMatch(/^A passkey was removed from two-step sign-in on Pixel 8/);
    expect(t("recovery_codes")).toMatch(/^New recovery codes were made on Pixel 8 \(Android app\), .+; the old ones no longer work\. Not you\?$/);
    expect(t("2fa_off")).toMatch(/^Two-step sign-in was turned off on Pixel 8 \(Android app\), .+\. Not you\?$/);
    expect(t("2fa_off", "")).toMatch(/^Two-step sign-in was turned off on an unknown device, /);
    for (const kind of ["totp_added", "totp_removed", "passkey_added", "passkey_removed", "recovery_codes", "2fa_off"]) {
      expect(usable({ notices: [{ id: 1, kind, device: "x", at: 1 }] })).toHaveLength(1);
      expect(noticeAction({ id: 1, kind: kind as Notice["kind"], device: "", at: 1 })).toEqual({ open: "2fa", label: "Review two-step sign-in" });
    }
  });
  it("links to what can be done about it", () => {
    expect(noticeAction({ id: 1, kind: "sign_in", device: "", at: 1 })).toEqual({ open: "devices", label: "Review devices" });
    expect(noticeAction({ id: 2, kind: "2fa_reset", device: "", at: 1 })).toEqual({ open: "2fa", label: "Open Account" });
    expect(noticeAction({ id: 3, kind: "password_used", device: "", at: 1 })).toEqual({ open: "password", label: "Change your password" });
  });
  it("sends a dismissal again that didn't reach the server", async () => {
    sent.list = [{ id: 7, kind: "sign_in", device: "x", at: 1 }, { id: 8, kind: "sign_in", device: "y", at: 2 }];
    const shown = await loadNotices(new Set([7]));
    expect(shown.map((n) => n.id)).toEqual([8]);
    expect(sent.dismissed).toEqual(["/api/me/notices/7/dismiss"]);
  });
});
