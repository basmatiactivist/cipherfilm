import { describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "cipherfilm" } } }));

const h = await import("./passkeyHandoff");

describe("passkeys through the browser", () => {
  it("takes the browser for a server on a private network, Android's own way for any other", async () => {
    for (const s of ["https://photos.tail3b37f7.ts.net", "https://192.168.1.20:8443", "https://10.0.0.5", "https://nas.local", "https://100.87.149.85", "https://localhost:8443"]) {
      expect(await h.viaBrowser(s), s).toBe(true);
    }
    for (const s of ["https://photos.example.org", "https://cipherfilm.app", "https://100.200.1.1"]) {
      expect(await h.viaBrowser(s), s).toBe(false);
    }
  });

  it("remembers a server Android refused", async () => {
    expect(await h.viaBrowser("https://photos.example.net")).toBe(false);
    h.rememberBrowser("https://photos.example.net/");
    expect(await h.viaBrowser("https://photos.example.net")).toBe(true);
  });

  it("puts what to do in the fragment, never in what the server is sent", () => {
    const u = h.handoffUrl("https://photos.example.org/", "get", { challenge: "abc", rpId: "photos.example.org" });
    expect(u.startsWith("https://photos.example.org/passkey#")).toBe(true);
    const frag = u.split("#")[1];
    const json = JSON.parse(atob(frag.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((frag.length + 3) % 4)));
    expect(json).toEqual({ op: "get", options: { challenge: "abc", rpId: "photos.example.org" }, app: "android" });
    expect(() => h.handoffUrl("http://photos.example.org", "get", {})).toThrow();
  });

  it("takes only its own return address, and reads the answer from it", () => {
    const ans = { id: "k", response: { clientDataJSON: "x" } };
    const b = btoa(JSON.stringify(ans)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(h.isPasskeyReturn(`cipherfilm://passkey#${b}`)).toBe(true);
    expect(h.isPasskeyReturn(`cipherfilm-mac://passkey#${b}`)).toBe(false);
    expect(h.isPasskeyReturn("cipherfilm://expo-sharing")).toBe(false);
    expect(h.readReturn(`cipherfilm://passkey#${b}`)).toEqual(ans);
    expect(h.readReturn("cipherfilm://passkey#error=cancelled")).toBeNull();
    expect(h.readReturn("cipherfilm://passkey#not-json")).toBeNull();
    expect(h.readReturn(`cipherfilm://passkey#${btoa("[1]")}`)).toBeNull();
  });
});
