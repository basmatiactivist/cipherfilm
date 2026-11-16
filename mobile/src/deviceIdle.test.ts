import { describe, expect, it, vi } from "vitest";
import { idleDaysOf, newestOwnUpload, sendLastUpload, unusedDevices, type LastUploadDeps } from "./deviceIdle";

const now = 1_800_000_000;
const day = 86400;

describe("unused devices", () => {
  it("takes the account's choice, or 30 days", () => {
    expect([7, 14, 30].map(idleDaysOf)).toEqual([7, 14, 30]);
    expect(idleDaysOf(undefined)).toBe(30);
    expect(idleDaysOf(10)).toBe(30);
    expect(idleDaysOf("7")).toBe(30);
  });

  it("counts other devices unused for longer than the limit, never this one", () => {
    const list = [
      { id: "this", current: true, last_seen: now - 40 * day },
      { id: "a", current: false, last_seen: now - 8 * day },
      { id: "b", current: false, last_seen: now - 7 * day },
      { id: "c", current: false, last_seen: now - 20 * day },
    ];
    expect(unusedDevices(list, 7, now).map((d) => d.id)).toEqual(["a", "c"]);
    expect(unusedDevices(list, 14, now).map((d) => d.id)).toEqual(["c"]);
    expect(unusedDevices(list, 30, now)).toEqual([]);
  });
});

describe("last upload of this phone", () => {
  it("is the newest item this phone uploaded", () => {
    const items = [{ id: "a", created_at: 100 }, { id: "b", created_at: 300 }, { id: "c", created_at: 200 }];
    expect(newestOwnUpload(items, new Set(["a", "c"]))).toBe(200);
    expect(newestOwnUpload(items, new Map([["b", "x"]]))).toBe(300);
    expect(newestOwnUpload(items, new Set())).toBe(0);
    expect(newestOwnUpload([], new Set(["a"]))).toBe(0);
  });

  const deps = (x: Partial<LastUploadDeps>) => {
    const posted: number[] = [];
    const marked: string[] = [];
    const d: LastUploadDeps = {
      sessionId: "s1", demo: false,
      sentFor: async () => undefined,
      markSent: async (s) => { marked.push(s); },
      newest: async () => 1234.7,
      post: async (at) => { posted.push(at); },
      ...x,
    };
    return { d, posted, marked };
  };

  it("is sent once per session, in whole seconds", async () => {
    const { d, posted, marked } = deps({});
    expect(await sendLastUpload(d)).toBe("sent");
    expect(posted).toEqual([1234]);
    expect(marked).toEqual(["s1"]);
  });

  it("isn't sent again for the same session, but is for a new one", async () => {
    const same = deps({ sentFor: async () => "s1" });
    expect(await sendLastUpload(same.d)).toBe("done");
    expect(same.posted).toEqual([]);
    const next = deps({ sentFor: async () => "s0" });
    expect(await sendLastUpload(next.d)).toBe("sent");
  });

  it("sends nothing without an upload, for the demo, or without a session id", async () => {
    for (const x of [{ newest: async () => 0 }, { demo: true }, { sessionId: undefined }] as Partial<LastUploadDeps>[]) {
      const { d, posted, marked } = deps(x);
      await sendLastUpload(d);
      expect(posted).toEqual([]);
      expect(marked).toEqual([]);
    }
  });

  it("isn't marked as sent when sending fails", async () => {
    const { d, marked } = deps({ post: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(sendLastUpload(d)).rejects.toThrow("offline");
    expect(marked).toEqual([]);
  });
});
