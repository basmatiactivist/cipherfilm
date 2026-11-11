import { describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ dismissed: [] as string[], list: [] as unknown[] }));
vi.mock("./api", () => ({
  api: async (method: string, path: string) => {
    if (method === "GET" && path === "/api/me/notices") return { notices: sent.list };
    if (method === "POST") { sent.dismissed.push(path); return { ok: true }; }
    throw new Error(path);
  },
}));
import { loadNotices, noticeAction, noticeText, usable } from "./notices";

describe("notices", () => {
  it("keeps known kinds only, newest first, without the dismissed", () => {
    const raw = { notices: [
      { id: 1, kind: "sign_in", device: "Pixel 8 (Android app)", at: 100 },
      { id: 2, kind: "2fa_reset", device: "", at: 300 },
      { id: 3, kind: "something_new", device: "", at: 400 },
      { id: 6, kind: "password_used", device: "", at: 250 },
      { id: 4, kind: "sign_in", at: 200 },
      { id: "5", kind: "sign_in", at: 500 },
      null,
    ] };
    expect(usable(raw).map((n) => n.id)).toEqual([2, 6, 4, 1]);
    expect(usable(raw, new Set([2])).map((n) => n.id)).toEqual([6, 4, 1]);
    expect(usable(raw)[2].device).toBe("");
    expect(usable({})).toEqual([]);
    expect(usable(null)).toEqual([]);
  });
  it("says what happened", () => {
    expect(noticeText({ id: 1, kind: "sign_in", device: "Firefox on Windows", at: 1_700_000_000 })).toMatch(/^New sign-in: Firefox on Windows, .+\. Not you\?$/);
    expect(noticeText({ id: 1, kind: "sign_in", device: "", at: 1_700_000_000 })).toContain("an unknown device");
    expect(noticeText({ id: 2, kind: "2fa_reset", device: "", at: 1_700_000_000 })).toMatch(/^An administrator turned off two-step sign-in/);
    expect(noticeText({ id: 3, kind: "password_used", device: "", at: 1_700_000_000 })).toMatch(/^Your password was used to start a sign-in that wasn't finished \(.+\)\. Not you\?$/);
  });
  it("links to what can be done about it", () => {
    expect(noticeAction({ id: 1, kind: "sign_in", device: "", at: 1 })).toEqual({ open: "devices", label: "Review devices" });
    expect(noticeAction({ id: 2, kind: "2fa_reset", device: "", at: 1 }).open).toBe("2fa");
    expect(noticeAction({ id: 3, kind: "password_used", device: "", at: 1 })).toEqual({ open: "password", label: "Change your password" });
  });
  it("sends a dismissal again that didn't reach the server", async () => {
    sent.list = [{ id: 7, kind: "sign_in", device: "x", at: 1 }, { id: 8, kind: "sign_in", device: "y", at: 2 }];
    const shown = await loadNotices(new Set([7]));
    expect(shown.map((n) => n.id)).toEqual([8]);
    expect(sent.dismissed).toEqual(["/api/me/notices/7/dismiss"]);
  });
});
