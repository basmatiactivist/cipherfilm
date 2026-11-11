import { beforeEach, describe, expect, it } from "vitest";
import type { Notice } from "./notices";

// the browser's storage, document and Notification, as stand-ins
const store = new Map<string, string>();
const posted: { title: string; body: string; tag: string; onclick?: () => void }[] = [];
const g = globalThis as any;
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
g.document = { visibilityState: "hidden" };
class FakeNotification {
  static permission = "default";
  static answer = "granted";
  static async requestPermission() { FakeNotification.permission = FakeNotification.answer; return FakeNotification.permission; }
  onclick?: () => void;
  constructor(title: string, o: { body: string; tag: string }) { const p = { title, ...o } as (typeof posted)[number]; posted.push(p); queueMicrotask(() => { p.onclick = this.onclick; }); }
  close() {}
}
g.window = { Notification: FakeNotification, focus: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
g.Notification = FakeNotification;

const { alertNotices, browserAlertsOn, forgetBrowserAlerts, pick, RECENT, setBrowserAlerts } = await import("./noticeAlerts");

const now = () => Date.now() / 1000;
const n = (id: number, at = now() - 60, kind: Notice["kind"] = "sign_in"): Notice => ({ id, kind, device: "Pixel 8 (Android app)", at });

beforeEach(() => { store.clear(); posted.length = 0; FakeNotification.permission = "default"; FakeNotification.answer = "granted"; g.document.visibilityState = "hidden"; });

describe("notices as browser notifications", () => {
  it("picks the new recent ones, oldest first, only while hidden", () => {
    const t = 1_800_000_000;
    expect(pick([n(3, t - 10), n(2, t - 20)], [], true, t).post.map((x) => x.id)).toEqual([2, 3]);
    expect(pick([n(3, t - 10)], [3], true, t).post).toEqual([]);
    expect(pick([n(4, t - 10)], [], false, t)).toEqual({ post: [], seen: [4] });
    expect(pick([n(5, t - RECENT - 1)], [], true, t).post).toEqual([]);
  });

  it("is off until turned on, and asks the browser only then", async () => {
    alertNotices([n(1)], () => {});
    expect(posted).toEqual([]);
    expect(FakeNotification.permission).toBe("default");
    expect(await setBrowserAlerts(true)).toBe(true);
    alertNotices([n(2), n(1)], () => {});
    expect(posted.map((p) => p.tag)).toEqual(["cf-notice-2"]); // 1 was seen while off
    expect(posted[0].title).toBe("New sign-in to Cipherfilm");
    expect(posted[0].body).toContain("Pixel 8");
    alertNotices([n(2), n(1)], () => {});
    expect(posted.length).toBe(1);
  });

  it("posts nothing while the tab is visible (the banner shows it), nor later", async () => {
    await setBrowserAlerts(true);
    g.document.visibilityState = "visible";
    alertNotices([n(7)], () => {});
    g.document.visibilityState = "hidden";
    alertNotices([n(7)], () => {});
    expect(posted).toEqual([]);
  });

  it("a click opens the notice's place; a refused permission keeps it off; sign-out forgets", async () => {
    await setBrowserAlerts(true);
    const opened: number[] = [];
    alertNotices([n(9)], (x) => opened.push(x.id));
    await Promise.resolve();
    posted[0].onclick?.();
    expect(opened).toEqual([9]);
    forgetBrowserAlerts();
    expect(browserAlertsOn()).toBe(false);
    expect(store.size).toBe(0);
    FakeNotification.permission = "default"; FakeNotification.answer = "denied";
    expect(await setBrowserAlerts(true)).toBe(false);
  });
});
