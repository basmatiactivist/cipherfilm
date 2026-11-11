import { beforeEach, describe, expect, it, vi } from "vitest";

// "Search your photos?" is asked once: the first check claims it, "asked" is saved with the answer, a screen that goes
// away before answering gives it back, and reads and saves of
// the settings file that overlap don't bring an older "asked: false" back. The file is a stand-in with a slow read.
const st = vi.hoisted(() => ({ file: null as string | null, reads: [] as (() => void)[], slow: false }));
vi.mock("expo-file-system", () => {
  class Directory { constructor(..._p: unknown[]) {} get exists() { return st.file !== null; } create() {} delete() { st.file = null; } }
  class File {
    constructor(..._p: unknown[]) {}
    get exists() { return st.file !== null; }
    async text() {
      const v = st.file!;
      if (st.slow) await new Promise<void>((r) => st.reads.push(r));
      return v;
    }
    async write(v: string) { st.file = v; }
  }
  return { Directory, File, Paths: { document: "/doc" } };
});

const fresh = async () => { vi.resetModules(); return import("./settings"); };

describe("search settings", () => {
  beforeEach(() => { Object.assign(st, { file: null, reads: [], slow: false }); });

  it("offers search once, also when two checks overlap", async () => {
    const m = await fresh();
    const answers = await Promise.all([m.claimOffer(), m.claimOffer()]);
    expect(answers.sort()).toEqual([false, true]);
    expect(await m.claimOffer()).toBe(false); // still open
    await m.answerOffer();
    m.releaseOffer(); // the screen leaves after the answer: nothing to give back
    expect(await m.claimOffer()).toBe(false);
    expect(JSON.parse(st.file!).asked).toBe(true);
    // the next start of the app reads it from the file
    expect(await (await fresh()).claimOffer()).toBe(false);
  });

  it("a screen that goes away before the answer gives the question back", async () => {
    const m = await fresh();
    expect(await m.claimOffer()).toBe(true);
    m.releaseOffer();
    expect(await m.claimOffer()).toBe(true);
    expect(st.file === null || JSON.parse(st.file).asked !== true).toBe(true);
  });

  it("doesn't offer it when search is on, and again for the next account after sign-out", async () => {
    const m = await fresh();
    await m.saveSettings({ enabled: true });
    expect(await m.claimOffer()).toBe(false);
    m.forgetSettings();
    expect(await m.claimOffer()).toBe(true);
  });

  it("a read of the file that overlaps a save doesn't bring the old settings back", async () => {
    st.file = JSON.stringify({ asked: false });
    st.slow = true;
    const m = await fresh();
    const early = m.loadSettings(); // still reading
    const saved = m.saveSettings({ asked: true });
    await new Promise((r) => setTimeout(r, 0));
    // a second read (if any) finishes first, and the save with it; the first read ends last
    const [first, ...later] = st.reads.splice(0);
    later.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 0));
    first();
    await early; await saved;
    expect((await m.loadSettings()).asked).toBe(true);
  });

  it("two saves at once both count", async () => {
    const m = await fresh();
    await Promise.all([m.saveSettings({ asked: true }), m.saveSettings({ enabled: true }), m.saveSettings({ faces: false })]);
    expect(await m.loadSettings()).toMatchObject({ asked: true, enabled: true, faces: false });
    expect(JSON.parse(st.file!)).toMatchObject({ asked: true, enabled: true, faces: false });
  });
});
