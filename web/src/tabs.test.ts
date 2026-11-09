import { afterEach, describe, expect, it, vi } from "vitest";
import { announce, endsHere, onAnnounce, resetTabs, sameSession, type TabSignal } from "./tabs";
import type { Me } from "./state";

const held = (user: string, session?: string) => ({ user: { id: user, email: `${user}@x.org`, role: "user" }, session_id: session }) as Me;
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("which signal from another tab ends this one", () => {
  it("a sign-in ends any account this tab holds, the same one too", () => {
    expect(endsHere({ t: "signed-in", user: "b", session: "s2" }, held("a", "s1"))).toBe(true);
    expect(endsHere({ t: "signed-in", user: "a", session: "s2" }, held("a", "s1"))).toBe(true);
    expect(endsHere({ t: "signed-in", user: "b" }, null)).toBe(false); // nothing held
  });

  it("a sign-out ends this tab's own session, not a newer one or another account's", () => {
    expect(endsHere({ t: "signed-out", user: "a", session: "s1" }, held("a", "s1"))).toBe(true);
    expect(endsHere({ t: "signed-out", user: "a", session: "s1" }, held("a", "s2"))).toBe(false);
    expect(endsHere({ t: "signed-out", user: "a", session: "s1" }, held("b", "s1"))).toBe(false);
    expect(endsHere({ t: "signed-out", user: "a" }, held("a", "s9"))).toBe(true); // a deleted account: every session
    expect(endsHere({ t: "signed-out", user: "a", session: "s1" }, null)).toBe(false);
  });

  it("compares the account, and the session where both sides know it", () => {
    expect(sameSession(held("a", "s1"), "a", "s1")).toBe(true);
    expect(sameSession(held("a", "s1"), "b", "s1")).toBe(false);
    expect(sameSession(held("a", "s1"), "a", "s2")).toBe(false);
    expect(sameSession(held("a"), "a", "s2")).toBe(true);
    expect(sameSession(null, "a", "s1")).toBe(false);
  });
});

describe("telling the other tabs", () => {
  afterEach(() => { resetTabs(); });

  it("reaches another tab over BroadcastChannel, and never this one", async () => {
    const heard: TabSignal[] = [];
    const stop = onAnnounce((s) => heard.push(s));
    const other = new BroadcastChannel("cf-tabs"); // another tab of the same origin
    const otherHeard: unknown[] = [];
    other.onmessage = (m) => otherHeard.push(m.data);
    announce({ t: "signed-out", user: "a", session: "s1" });
    await tick();
    expect(otherHeard).toEqual([{ t: "signed-out", user: "a", session: "s1" }]);
    expect(heard).toEqual([]);
    other.postMessage({ t: "signed-in", user: "b" });
    other.postMessage({ t: "bogus", user: "b" });
    other.postMessage("not json");
    await tick();
    expect(heard).toEqual([{ t: "signed-in", user: "b" }]);
    stop();
    other.postMessage({ t: "signed-in", user: "c" });
    await tick();
    expect(heard.length).toBe(1);
    other.close();
  });

  it("falls back to a storage event without BroadcastChannel", () => {
    const store = new Map<string, string>();
    const listeners = new Set<(e: StorageEvent) => void>();
    const writes: string[] = [];
    const env = {
      localStorage: {
        setItem: (k: string, v: string) => { store.set(k, v); writes.push(v); },
        removeItem: (k: string) => { store.delete(k); },
      } as unknown as Storage,
      addEventListener: (_t: "storage", f: (e: StorageEvent) => void) => { listeners.add(f); },
      removeEventListener: (_t: "storage", f: (e: StorageEvent) => void) => { listeners.delete(f); },
    };
    const heard: TabSignal[] = [];
    const stop = onAnnounce((s) => heard.push(s), env);
    announce({ t: "signed-in", user: "b", session: "s2" }, env);
    announce({ t: "signed-in", user: "b", session: "s2" }, env);
    expect(writes.length).toBe(2);
    expect(writes[0]).not.toBe(writes[1]); // each one changes the value, so each one fires
    expect(store.size).toBe(0); // nothing stays behind
    // the browser fires the event in the other tabs; here, the one listener stands in for one
    for (const f of listeners) f({ key: "cf-tabs", newValue: writes[0] } as StorageEvent);
    for (const f of listeners) f({ key: "cf-tabs", newValue: null } as StorageEvent); // the removal
    for (const f of listeners) f({ key: "other", newValue: writes[0] } as StorageEvent);
    expect(heard).toEqual([expect.objectContaining({ t: "signed-in", user: "b", session: "s2" })]);
    stop();
    expect(listeners.size).toBe(0);
  });

  it("doesn't fail where neither is available", () => {
    expect(() => announce({ t: "signed-out", user: "a" }, {})).not.toThrow();
    expect(() => onAnnounce(vi.fn(), {})()).not.toThrow();
  });
});
