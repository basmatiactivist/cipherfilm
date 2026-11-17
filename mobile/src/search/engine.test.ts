import { describe, expect, it, vi } from "vitest";

// A picture the native side can't use gets an empty entry once, instead of failing again at every start.
const nat = vi.hoisted(() => ({ analyze: async (..._a: unknown[]): Promise<unknown> => ({}) }));
vi.mock("expo-file-system", () => ({ Directory: class {}, File: class {}, Paths: {} }));
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({ default: { visionAnalyze: (...a: unknown[]) => nat.analyze(...a) } }));
vi.mock("../api", () => ({ api: async () => ({}), ApiError: class extends Error {}, server: () => "" }));
vi.mock("../prints", () => ({ fingerprint: async () => "" }));
vi.mock("../ownUploads", () => ({ matchable: async () => [] }));
vi.mock("../session", () => ({ onWipe: () => {}, refreshMe: async () => null, session: () => ({}) }));
vi.mock("../library", () => ({ imageBytes: async () => new Uint8Array(0) }));
vi.mock("../keepAlive", () => ({ keepRunning: () => false, letGo: () => {}, onlyHolder: () => false }));
vi.mock("./settings", () => ({ loadSettings: async () => ({}), saveSettings: async () => {}, settingsDir: () => ({}) }));
vi.mock("./models", () => ({ modelTag: (c: string, f: boolean) => `${c}/${f ? "faces" : "plain"}`, family: (c: string) => c, CLIP: "clip-b32" }));

const { analyzeBytes, needsText } = await import("./engine");
const { getSodium } = await import("@crypto/sodium");
const { entryText, OCR_TAG, openIndexEntry, sealIndexEntry, TEXT_BYTES } = await import("@crypto/search");

describe("analyzeBytes", () => {
  it("stores an empty entry for an unusable picture, and wipes the bytes", async () => {
    nat.analyze = async () => { throw Object.assign(new Error("not a usable picture"), { code: "ERR_UNUSABLE_IMAGE" }); };
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await analyzeBytes(bytes, true, ["clip-b32"])).toEqual([{ v: 1, m: "clip-b32/faces", faces: [] }]);
    expect(await analyzeBytes(new Uint8Array(1), false, ["clip-b32"])).toEqual([{ v: 1, m: "clip-b32/plain" }]);
    expect([...bytes]).toEqual([0, 0, 0]);
  });

  it("passes other failures on, so they are tried again", async () => {
    nat.analyze = async () => { throw new Error("search models not loaded"); };
    await expect(analyzeBytes(new Uint8Array(1), false, ["clip-b32"])).rejects.toThrow(/not loaded/);
  });

  it("turns an analysis into an entry", async () => {
    nat.analyze = async () => ({ clips: [new Uint8Array([1, 2])] });
    const [e] = await analyzeBytes(new Uint8Array(1), false, ["clip-b32"]);
    expect(e.m).toBe("clip-b32/plain");
    expect(typeof e.clip).toBe("string");
  });

  it("with the faces given (from the item's MobileCLIP entry, made before one model) doesn't look for them again", async () => {
    const asked: unknown[][] = [];
    nat.analyze = async (...a: unknown[]) => { asked.push(a.slice(1)); return { clips: [new Uint8Array([1, 2])] }; };
    const known = [{ box: [0.1, 0.1, 0.2, 0.2], score: 0.95, emb: "AAAA" }];
    const [e] = await analyzeBytes(new Uint8Array(1), true, ["clip-b32"], known);
    expect(asked).toEqual([[false, ["clip-b32"], false]]);
    expect(e).toMatchObject({ m: "clip-b32/faces", faces: known });
    // an unusable picture keeps them too
    nat.analyze = async () => { throw Object.assign(new Error("not a usable picture"), { code: "ERR_UNUSABLE_IMAGE" }); };
    expect(await analyzeBytes(new Uint8Array(1), true, ["clip-b32"], known)).toEqual([{ v: 1, m: "clip-b32/faces", faces: known }]);
  });
});

describe("text in photos in the entry", () => {
  it("with the text models open, the entry says so and holds the text in its fixed-size slot; sealed and opened again", async () => {
    const asked: unknown[][] = [];
    nat.analyze = async (...a: unknown[]) => { asked.push(a.slice(1)); return { clips: [new Uint8Array([1, 2])], text: "BAKERY OPEN Zürich Hauptbahnhof Gleis 7 Fresh bread daily", ocrMs: 120 }; };
    const [e] = await analyzeBytes(new Uint8Array(1), false, ["clip-b32"], undefined, true);
    expect(asked[0][2]).toBe(true);
    expect(e.o).toBe(OCR_TAG);
    expect(new TextEncoder().encode(e.t!).length).toBe(TEXT_BYTES);
    const s = await getSodium();
    const kp = s.crypto_box_keypair();
    const id = "0123456789abcdef0123456789abcdef";
    const back = openIndexEntry(s, sealIndexEntry(s, e, kp.publicKey, id), { pk: kp.publicKey, sk: kp.privateKey }, id);
    expect(back).toEqual(e);
    expect(entryText(back)).toBe("BAKERY OPEN Zürich Hauptbahnhof Gleis 7 Fresh bread daily");
    // every entry with text is the same size, whatever the photo says
    const other = { ...e, t: e.t!.replace(/\S+/g, "x") };
    expect(sealIndexEntry(s, other, kp.publicKey, id).length).toBe(sealIndexEntry(s, e, kp.publicKey, id).length);
  });

  it("no text found still marks the entry as read (not read again); an unusable picture too", async () => {
    nat.analyze = async () => ({ clips: [new Uint8Array([1, 2])], text: "" });
    const [e] = await analyzeBytes(new Uint8Array(1), false, ["clip-b32"], undefined, true);
    expect(e.o).toBe(OCR_TAG);
    expect(entryText(e)).toBe("");
    nat.analyze = async () => { throw Object.assign(new Error("not a usable picture"), { code: "ERR_UNUSABLE_IMAGE" }); };
    const [u] = await analyzeBytes(new Uint8Array(1), false, ["clip-b32"], undefined, true);
    expect(u).toMatchObject({ v: 1, m: "clip-b32/plain", o: OCR_TAG });
  });

  it("text models not open (or text in photos off): an entry as before, without o, read later", async () => {
    nat.analyze = async () => ({ clips: [new Uint8Array([1, 2])] });
    const [a] = await analyzeBytes(new Uint8Array(1), false, ["clip-b32"], undefined, true);
    const [b] = await analyzeBytes(new Uint8Array(1), false, ["clip-b32"]);
    expect("o" in a || "t" in a || "o" in b || "t" in b).toBe(false);
  });

  it("an old entry without o opens as before, with no text", async () => {
    const s = await getSodium();
    const kp = s.crypto_box_keypair();
    const id = "0123456789abcdef0123456789abcdef";
    const old = { v: 1 as const, m: "laionb32/1", clip: "AAAA" };
    const back = openIndexEntry(s, sealIndexEntry(s, old, kp.publicKey, id), { pk: kp.publicKey, sk: kp.privateKey }, id);
    expect(back).toEqual(old);
    expect(entryText(back)).toBe("");
  });
});

describe("which photos get their text read again", () => {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "image", itemKey: new Uint8Array(32), has_preview: true, has_thumb: true, ...extra }) as never;
  it("those with a current, stored entry made before text in photos; newest first as given", () => {
    const tags = new Map([["a", "clip-b32/faces"], ["b", "clip-b32/faces"], ["c", "clip-b32/faces"], ["d", "mcs2+yunet23+sface21/2"], ["e", "clip-b32/faces"], ["f", "clip-b32/faces"]]);
    const by = new Map([["b", OCR_TAG], ["c", "someotherreader/1"]]);
    const entries = { a: "x", b: "x", c: "x", d: "x", f: "x" };
    const list = [item("a"), item("b"), item("c"), item("d"), item("e"), item("f", { broken: true }), item("g")];
    // a: never read; b: read; c: by another reader, read again; d: an old model's entry (made again whole);
    // e: nothing stored to keep; f: can't be opened; g: no entry at all
    expect(needsText(list, true, entries, by, tags).map((i: { id: string }) => i.id)).toEqual(["a", "c"]);
    // faces on: an entry without faces is made again whole, not only read
    const plain = new Map([["a", "clip-b32/plain"]]);
    expect(needsText([item("a")], true, { a: "x" }, new Map(), plain)).toEqual([]);
    expect(needsText([item("a")], false, { a: "x" }, new Map(), plain).length).toBe(1);
  });
});
