import { beforeEach, describe, expect, it, vi } from "vitest";

// Administration: the requests (exactly the web's, server/handlers_admin.go), the checks and the wording.
// The server is a stand-in that records what it was asked.
const st = vi.hoisted(() => ({ calls: [] as { method: string; path: string; body?: unknown }[], reply: (): unknown => ({ ok: true }) }));
vi.mock("./api", () => ({
  api: async (method: string, path: string, body?: unknown) => { st.calls.push({ method, path, body }); const r = st.reply(); if (r instanceof Error) throw r; return r; },
  server: () => "https://photos.example.test/",
}));

const a = await import("./admin");
const { setLang } = await import("./i18n");
const ID = "0123456789abcdef0123456789abcdef";
const user = (o: Partial<import("./admin").AdminUser> = {}): import("./admin").AdminUser => ({
  id: ID, email: "a@x.test", role: "user", status: "active", created_at: 1, last_login_at: 0, quota_bytes: 10e9,
  used_bytes: 2.5e9, item_count: 3, nsfw: false, ...o,
});

describe("administration", () => {
  beforeEach(() => { st.calls = []; st.reply = () => ({ ok: true }); setLang("en"); });

  it("is offered to admins only, never to the demo login", () => {
    expect(a.isAdmin({ user: { role: "admin" } })).toBe(true);
    expect(a.isAdmin({ user: { role: "user" } })).toBe(false);
    expect(a.isAdmin({ user: { role: "admin" }, demo: true })).toBe(false);
    expect(a.isAdmin(null)).toBe(false);
    expect(a.isAdmin(undefined)).toBe(false);
  });

  it("reads a refused request as no access (the server says not found to non-admins)", () => {
    expect(a.noAccess(Object.assign(new Error("x"), { status: 404 }))).toBe(true);
    expect(a.noAccess(Object.assign(new Error("x"), { status: 403 }))).toBe(true);
    expect(a.noAccess(Object.assign(new Error("x"), { status: 0 }))).toBe(false);
    expect(a.noAccess(Object.assign(new Error("x"), { status: 409 }))).toBe(false);
    expect(a.noAccess(null)).toBe(false);
  });

  it("sends the web's requests", async () => {
    await a.setEnabled(ID, false);
    await a.setEnabled(ID, true);
    await a.setAdmin(ID, true);
    await a.setAdmin(ID, false);
    await a.setExplicit(ID, true);
    await a.setLimit(ID, 5e9);
    await a.deleteUser(ID);
    await a.resetTwoStep(ID);
    await a.revokeInvite(ID);
    await a.setDefaultLimit(0);
    expect(st.calls).toEqual([
      { method: "PATCH", path: `/api/admin/users/${ID}`, body: { status: "disabled" } },
      { method: "PATCH", path: `/api/admin/users/${ID}`, body: { status: "active" } },
      { method: "PATCH", path: `/api/admin/users/${ID}`, body: { role: "admin" } },
      { method: "PATCH", path: `/api/admin/users/${ID}`, body: { role: "user" } },
      { method: "PATCH", path: `/api/admin/users/${ID}`, body: { nsfw: true } },
      { method: "PATCH", path: `/api/admin/users/${ID}`, body: { quota_bytes: 5e9 } },
      { method: "DELETE", path: `/api/admin/users/${ID}`, body: undefined },
      { method: "DELETE", path: `/api/admin/users/${ID}/2fa`, body: undefined },
      { method: "DELETE", path: `/api/admin/invites/${ID}`, body: undefined },
      { method: "PATCH", path: "/api/admin/settings", body: { default_quota_bytes: 0 } },
    ]);
  });

  it("never puts anything but a server id into a path", async () => {
    for (const bad of ["../me", "x", ID.toUpperCase(), ID + "/2fa", ""]) {
      await expect(a.deleteUser(bad)).rejects.toThrow();
      await expect(a.setEnabled(bad, false)).rejects.toThrow();
    }
    expect(st.calls).toEqual([]);
  });

  it("creates an invite and makes the link from the server's address", async () => {
    st.reply = () => ({ token: "tok_en-1", email: "b@x.test", expires_at: 99 });
    expect(await a.createInvite(" b@x.test ", "")).toEqual({ link: "https://photos.example.test/invite/tok_en-1", email: "b@x.test", expires_at: 99 });
    expect(st.calls[0]).toEqual({ method: "POST", path: "/api/admin/invites", body: { email: "b@x.test" } });
    await a.createInvite("c@x.test", "2,5");
    expect(st.calls[1].body).toEqual({ email: "c@x.test", quota_bytes: 2.5e9 });
    await a.createInvite("c@x.test", "0");
    expect(st.calls[2].body).toEqual({ email: "c@x.test", quota_bytes: 0 });
    await expect(a.createInvite("c@x.test", "lots")).rejects.toThrow(/number of GB/);
    expect(st.calls.length).toBe(3);
  });

  it("passes the server's refusal on", async () => {
    st.reply = () => Object.assign(new Error("At least one active administrator must remain."), { status: 409 });
    await expect(a.setAdmin(ID, false)).rejects.toThrow("At least one active administrator must remain.");
  });

  it("reads storage limits as typed", () => {
    expect(a.parseGB("5")).toBe(5e9);
    expect(a.parseGB(" 1.5 ")).toBe(1.5e9);
    expect(a.parseGB("1,5")).toBe(1.5e9);
    expect(a.parseGB("0")).toBe(0);
    expect(a.parseGB("", true)).toBeUndefined();
    expect(() => a.parseGB("")).toThrow();
    expect(() => a.parseGB("-1")).toThrow();
    expect(() => a.parseGB("abc")).toThrow();
    expect(() => a.parseGB("Infinity")).toThrow();
  });

  it("says sizes, usage and last sign-in as the web does", () => {
    expect(a.size(2.5e9)).toBe("2.5 GB");
    expect(a.size(12e6)).toBe("12 MB");
    expect(a.size(10)).toBe("less than 1 MB");
    expect(a.size(0)).toBe("0 MB");
    expect(a.limitText(0)).toBe("no limit");
    expect(a.usageLine(user())).toBe("2.5 GB of 10.0 GB · 3 items");
    expect(a.usageLine(user({ quota_bytes: 0, item_count: 1 }))).toBe("2.5 GB used, no limit · 1 item");
    const now = 1_700_000_000;
    expect(a.lastSeen(0, now)).toBe("never signed in");
    expect(a.lastSeen(now - 60, now)).toBe("active today");
    expect(a.lastSeen(now - 86400, now)).toBe("active yesterday");
    expect(a.lastSeen(now - 5 * 86400, now)).toBe("active 5 days ago");
    expect(a.summaryLine([user(), user({ used_bytes: 0.5e9, item_count: 1 })])).toBe("2 people · 3.0 GB stored · 4 items");
    expect(a.uptime(90)).toBe("1 minute");
    expect(a.uptime(3600)).toBe("1 hour");
    expect(a.uptime(30)).toBe("less than a minute");
    expect(a.uptime(7200)).toBe("2 hours");
    expect(a.uptime(3 * 86400)).toBe("3 days");
  });

  it("shows explicit search only where this build offers it", () => {
    const u = user({ role: "admin", status: "disabled", nsfw: true, two_factor: true });
    expect(a.badges(u, true)).toEqual(["admin", "disabled", "explicit search", "two-step sign-in"]);
    expect(a.badges(u, false)).toEqual(["admin", "disabled", "two-step sign-in"]);
    expect(a.badges(user(), true)).toEqual(["user"]);
  });

  it("tells the off-site backup's state", () => {
    const now = 1_700_000_000;
    expect(a.backupState({}, now).problem).toBeUndefined();
    expect(a.backupState({ backup_ok_at: now - 3600 }, now).problem).toBeUndefined();
    expect(a.backupState({ backup_ok_at: now - 40 * 3600 }, now).problem).toMatch(/^No off-site backup since/);
    expect(a.backupState({ backup_ok_at: now - 7200, backup_failed_at: now - 60, backup_failed_in: "snapshot" }, now).problem).toMatch(/database snapshot couldn't be written.*Last successful one/);
    expect(a.backupState({ backup_failed_at: now - 60, backup_failed_in: "upload" }, now).problem).toMatch(/backup target\. None has succeeded yet\.$/);
  });

  it("writes the activity log as sentences, grouped by day", () => {
    const e = (action: string, o: Partial<import("./admin").AuditEntry> = {}) => ({ at: 0, actor: "me@x.test", action, target: "b@x.test", detail: "", ...o });
    expect(a.describe(e("invited"), "me@x.test").text).toBe("You invited b@x.test");
    expect(a.describe(e("role changed", { actor: "c@x.test", detail: "admin", target: "me@x.test" }), "me@x.test").text).toBe("c@x.test made you an administrator");
    expect(a.describe(e("deleted"), "me@x.test")).toEqual({ icon: "trash", text: "You deleted b@x.test and everything they stored", warn: true });
    expect(a.describe(e("storage limit changed", { detail: "0" }), "me@x.test").text).toBe("You set the storage limit of b@x.test to no limit");
    expect(a.describe(e("signed out every device", { actor: "server console", detail: "wipe" }), "me@x.test").text).toBe("The server console signed out every device of b@x.test, and they delete what they keep");
    expect(a.describe(e("joined", { actor: "b@x.test" }), "me@x.test").text).toBe("b@x.test joined");
    expect(a.describe(e("something new", { detail: "d" }), "me@x.test")).toEqual({ icon: "info", text: "You something new · b@x.test (d)" });
    const day = new Date(2026, 10, 11, 12).getTime();
    const list = [e("invited", { at: day / 1000 }), e("enabled", { at: day / 1000 - 3600 }), e("disabled", { at: day / 1000 - 86400 })];
    const groups = a.byDay(list, day);
    expect(groups.map(([d, l]) => [d, l.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
  });

  it("speaks German", () => {
    setLang("de");
    expect(a.describe({ at: 0, actor: "me@x.test", action: "invited", target: "b@x.test", detail: "" }, "me@x.test").text).toBe("Sie: b@x.test eingeladen");
    expect(a.usageLine(user())).toBe("2,5 GB von 10,0 GB · 3 Elemente");
    expect(a.lastSeen(0)).toBe("nie angemeldet");
    setLang("en");
  });
});
