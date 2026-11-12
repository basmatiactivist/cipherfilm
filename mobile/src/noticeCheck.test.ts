import { beforeEach, describe, expect, it, vi } from "vitest";

// The background check for account notices: real noticeCheck, noticeAlerts and api code; the server, the phone's files
// and Android's notifications are stand-ins.
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-file-system", () => {
  const pathOf = (p: unknown) => (typeof p === "string" ? p : (p as { uri: string }).uri);
  class Directory {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return [...files.keys()].some((k) => k.startsWith(this.uri + "/")); }
    create() {}
    delete() { for (const k of [...files.keys()]) if (k.startsWith(this.uri + "/")) files.delete(k); }
  }
  class File {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return files.has(this.uri); }
    textSync() { return files.get(this.uri)!; }
    async text() { return files.get(this.uri)!; }
    async write(v: string) { files.set(this.uri, v); }
    delete() { files.delete(this.uri); }
  }
  return { Directory, File, Paths: { document: "/doc", cache: "/cache" } };
});
const app = vi.hoisted(() => ({ state: "background" as string }));
vi.mock("react-native", () => ({ Platform: { constants: { Model: "Test" } }, AppState: { get currentState() { return app.state; } } }));
const phone = vi.hoisted(() => ({ allowed: true, shown: [] as { id: number; title: string; text: string; pub: string }[], cancelled: [] as number[] }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    noticesAllowed: () => phone.allowed,
    noticeShow: (id: number, title: string, text: string, pub: string) => { if (!phone.allowed) return false; phone.shown.push({ id, title, text, pub }); return true; },
    noticeCancel: (id: number) => { phone.cancelled.push(id); },
    noticeCancelAll: () => { phone.cancelled.push(-1); },
  },
}));
const signOuts = vi.hoisted(() => [] as (() => void)[]);
const srv = vi.hoisted(() => ({ server: "https://photos.example", status: 200, notices: [] as unknown[], requests: [] as { url: string; headers: Record<string, string> }[] }));
vi.mock("./session", () => ({ onSignOut: (f: () => void) => { signOuts.push(f); }, savedServer: async () => srv.server }));
vi.mock("expo/fetch", () => ({
  fetch: async (url: string, init: { headers?: Record<string, string> } = {}) => {
    srv.requests.push({ url, headers: init.headers ?? {} });
    return new Response(JSON.stringify(srv.status === 200 ? { notices: srv.notices } : { error: "not signed in" }), { status: srv.status });
  },
}));

import { checkNotices, noticeCheckWanted, setNoticeAlerts, shownInApp } from "./noticeCheck";
import { setLang } from "./i18n";

const now = () => Math.floor(Date.now() / 1000);
const notice = (id: number, at = now() - 60, kind = "sign_in", device = "Firefox on Linux") => ({ id, kind, device, at });

beforeEach(() => {
  files.clear();
  app.state = "background";
  phone.allowed = true; phone.shown = []; phone.cancelled = [];
  srv.status = 200; srv.notices = []; srv.requests = [];
  setNoticeAlerts(true);
  setLang("en");
});

describe("account notices as notifications", () => {
  it("asks nothing before the app has loaded the notices after signing in", async () => {
    srv.notices = [notice(1)];
    expect(noticeCheckWanted()).toBe(false);
    expect(await checkNotices()).toBe(0);
    expect(srv.requests).toEqual([]);
  });

  it("shows a new one once, as a background request, never one the banner already showed", async () => {
    srv.notices = [notice(1)];
    expect(await shownInApp([{ id: 1, kind: "sign_in", device: "x", at: now() }], srv.server)).toBe(true); // first: schedule
    expect(await shownInApp([], srv.server)).toBe(false);
    expect(noticeCheckWanted()).toBe(true);
    expect(await checkNotices()).toBe(0);
    srv.notices = [notice(2), notice(1)];
    expect(await checkNotices()).toBe(1);
    expect(await checkNotices()).toBe(0);
    expect(phone.shown.map((s) => s.id)).toEqual([2]);
    expect(phone.shown[0].pub).toBe("New sign-in to Cipherfilm");
    expect(phone.shown[0].text).toContain("Firefox on Linux");
    const r = srv.requests.at(-1)!;
    expect(r.url).toBe("https://photos.example/api/me/notices");
    expect(r.headers["X-CF-Background"]).toBe("1");
  });

  it("posts nothing while the app is on screen", async () => {
    await shownInApp([], srv.server);
    srv.notices = [notice(3)];
    app.state = "active";
    expect(await checkNotices()).toBe(0);
    expect(srv.requests).toEqual([]);
    expect(phone.shown).toEqual([]);
  });

  it("nothing when switched off; and when Android doesn't allow it, the notice comes once it does", async () => {
    await shownInApp([], srv.server);
    srv.notices = [notice(4)];
    setNoticeAlerts(false);
    expect(phone.cancelled).toContain(-1);
    expect(await checkNotices()).toBe(0);
    expect(srv.requests).toEqual([]);
    setNoticeAlerts(true);
    phone.allowed = false;
    expect(await checkNotices()).toBe(0);
    phone.allowed = true;
    expect(await checkNotices()).toBe(1);
    expect(phone.shown.map((s) => s.id)).toEqual([4]);
  });

  it("a session that ended or a server that isn't reached: nothing, and nothing marked", async () => {
    await shownInApp([], srv.server);
    srv.notices = [notice(5)];
    srv.status = 401;
    expect(await checkNotices()).toBe(0);
    srv.status = 200;
    expect(await checkNotices()).toBe(1);
  });

  it("takes down the notification once the notice is dismissed or shown in the app", async () => {
    await shownInApp([], srv.server);
    srv.notices = [notice(6), notice(7)];
    await checkNotices();
    srv.notices = [notice(7)]; // 6 dismissed on another device
    await checkNotices();
    expect(phone.cancelled).toContain(6);
    await shownInApp([{ id: 7, kind: "sign_in", device: "", at: now() }], srv.server);
    expect(phone.cancelled).toContain(7);
  });

  it("sign-out forgets the list and the setting, and stops the check", async () => {
    await shownInApp([], srv.server);
    setNoticeAlerts(false);
    signOuts.forEach((f) => f());
    expect(noticeCheckWanted()).toBe(false);
    expect([...files.keys()]).toEqual([]);
    await shownInApp([], srv.server);
    expect(noticeCheckWanted()).toBe(true); // back on by default after signing in again
  });
});
