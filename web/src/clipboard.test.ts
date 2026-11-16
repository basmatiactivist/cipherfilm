import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A copied secret leaves the clipboard after a minute, as on Android and the Mac; something copied since stays.
let board: string;
let focused: boolean;
let readable: boolean;
const listeners = new Map<string, Set<() => void>>();
const target = () => ({
  addEventListener: (t: string, f: () => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f); },
  removeEventListener: (t: string, f: () => void) => listeners.get(t)?.delete(f),
});
const fire = (t: string) => [...(listeners.get(t) ?? [])].forEach((f) => f());

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  board = ""; focused = true; readable = false; listeners.clear();
  vi.stubGlobal("navigator", {
    clipboard: { writeText: async (t: string) => { if (!focused) throw new Error("not focused"); board = t; }, readText: async () => board },
    permissions: { query: async () => ({ state: readable ? "granted" : "prompt" }) },
  });
  vi.stubGlobal("document", { ...target(), hasFocus: () => focused });
  vi.stubGlobal("window", target());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("copied secrets", () => {
  it("are cleared after a minute", async () => {
    const { copySecret, CLEAR_AFTER } = await import("./clipboard");
    await copySecret("the recovery key");
    expect(board).toBe("the recovery key");
    await vi.advanceTimersByTimeAsync(CLEAR_AFTER - 1000);
    expect(board).toBe("the recovery key");
    await vi.advanceTimersByTimeAsync(1000);
    expect(board).toBe("");
  });

  it("are cleared when the person comes back, if the page wasn't focused at the time", async () => {
    const { copySecret, CLEAR_AFTER, pendingClear } = await import("./clipboard");
    await copySecret("JBSWY3DPEHPK3PXP");
    focused = false;
    await vi.advanceTimersByTimeAsync(CLEAR_AFTER);
    expect(board).toBe("JBSWY3DPEHPK3PXP");
    expect(pendingClear()).toBe(true);
    focused = true;
    fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toBe("");
    expect(pendingClear()).toBe(false);
  });

  it("leave something copied on this page since alone", async () => {
    const { copySecret, CLEAR_AFTER } = await import("./clipboard");
    await copySecret("code-1\ncode-2");
    board = "something else"; fire("copy");
    await vi.advanceTimersByTimeAsync(CLEAR_AFTER);
    expect(board).toBe("something else");
  });

  it("leave something copied elsewhere alone where the clipboard can be read", async () => {
    const { copySecret, CLEAR_AFTER } = await import("./clipboard");
    readable = true;
    await copySecret("https://photos.example.test/#invite=x");
    board = "copied in another app";
    await vi.advanceTimersByTimeAsync(CLEAR_AFTER);
    expect(board).toBe("copied in another app");
  });

  it("clear only the latest secret, once", async () => {
    const { copySecret, CLEAR_AFTER } = await import("./clipboard");
    await copySecret("first");
    await vi.advanceTimersByTimeAsync(CLEAR_AFTER / 2);
    await copySecret("second");
    await vi.advanceTimersByTimeAsync(CLEAR_AFTER / 2);
    expect(board).toBe("second");
    await vi.advanceTimersByTimeAsync(CLEAR_AFTER / 2);
    expect(board).toBe("");
  });

  it("fail as a copy does when the browser refuses", async () => {
    const { copySecret, pendingClear } = await import("./clipboard");
    focused = false;
    await expect(copySecret("x")).rejects.toThrow();
    expect(pendingClear()).toBe(false);
  });
});
