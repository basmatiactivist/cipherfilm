import { describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "cipherfilm" } } }));

const h = await import("./passkeyHandoff");

const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** A passkey's answer as the /passkey page sends it (web/src/passkeys.ts credentialJSON): the browser's client data
 *  names the page's origin, the kind of request and its challenge. */
const answer = (origin: string, type: string, challenge: string, extra: object = {}) => ({
  id: "k", rawId: "k", type: "public-key",
  response: { clientDataJSON: b64u(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra })), authenticatorData: "AA", signature: "AA" },
});

describe("passkeys through the browser", () => {
  it("takes the browser for a server on a private network, Android's own way for any other", async () => {
    for (const s of ["https://photos.example-tailnet.ts.net", "https://192.168.1.20:8443", "https://10.0.0.5", "https://nas.local", "https://100.64.0.5", "https://localhost:8443"]) {
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
    const u = h.handoffUrl("https://photos.example.org/", "get", { challenge: "abc", rpId: "photos.example.org" }, "0123456789abcdef0123456789abcdef");
    expect(u.startsWith("https://photos.example.org/passkey#")).toBe(true);
    const frag = u.split("#")[1];
    const json = JSON.parse(atob(frag.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((frag.length + 3) % 4)));
    expect(json).toEqual({ op: "get", options: { challenge: "abc", rpId: "photos.example.org" }, app: "android", state: "0123456789abcdef0123456789abcdef" });
    expect(() => h.handoffUrl("http://photos.example.org", "get", {}, "x")).toThrow();
  });

  it("takes only its own return address, and reads the state and the answer from it", () => {
    const ans = { id: "k", response: { clientDataJSON: "x" } };
    const b = btoa(JSON.stringify(ans)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(h.isPasskeyReturn(`cipherfilm://passkey#s=abc&a=${b}`)).toBe(true);
    expect(h.isPasskeyReturn(`cipherfilm-mac://passkey#${b}`)).toBe(false);
    expect(h.isPasskeyReturn("cipherfilm://expo-sharing")).toBe(false);
    expect(h.readReturn(`cipherfilm://passkey#s=abc&a=${b}`)).toEqual({ state: "abc", answer: ans });
    expect(h.readReturn("cipherfilm://passkey#s=abc&error=cancelled")).toEqual({ state: "abc", answer: null });
    expect(h.readReturn(`cipherfilm://passkey#${b}`)).toEqual({ state: "", answer: null }); // no state: never taken
    expect(h.readReturn("cipherfilm://passkey#s=abc&a=not-json")).toEqual({ state: "abc", answer: null });
  });

  it("gives an answer only to the request whose state it carries", async () => {
    const m = h;
    const opened: string[] = [];
    const platform = { openURL: async (u: string) => { opened.push(u); }, onAppState: () => ({ remove() {} }), away() {} };
    const ans = answer("https://nas.local", "webauthn.get", "Y2hhbGxlbmdl");
    const b = b64u(JSON.stringify(ans));
    const p = m.viaBrowserPasskey("https://nas.local", "get", { challenge: "Y2hhbGxlbmdl" }, platform);
    await new Promise((r) => setTimeout(r, 50));
    const frag = opened[0].split("#")[1];
    const state = JSON.parse(atob(frag.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((frag.length + 3) % 4))).state as string;
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    m.passkeyReturned(`cipherfilm://passkey#s=someoneelse&a=${b}`); // ignored
    m.passkeyReturned(`cipherfilm://passkey#s=${state}&a=${b}`);
    await expect(p).resolves.toEqual(ans);
  });

  it("takes only an answer made on the configured server's own page for this request", () => {
    const srv = "https://photos-a.test", ch = "QV9DSEFMTEVOR0U";
    expect(h.answerFor(answer("https://photos-a.test", "webauthn.get", ch), srv, "get", { challenge: ch })).toBe(true);
    expect(h.answerFor(answer("https://photos-a.test", "webauthn.create", ch), srv + "/", "create", { challenge: ch })).toBe(true);
    // padding or the other base64 alphabet in the server's options change nothing
    expect(h.answerFor(answer("https://photos-a.test", "webauthn.get", "-_8"), srv, "get", { challenge: "+/8=" })).toBe(true);
    // another server's page (the configured one sent the browser on to it), another challenge, another kind of request
    expect(h.answerFor(answer("https://photos-b.test", "webauthn.get", ch), srv, "get", { challenge: ch })).toBe(false);
    expect(h.answerFor(answer("https://photos-a.test", "webauthn.get", "Ql9DSEFMTEVOR0U"), srv, "get", { challenge: ch })).toBe(false);
    expect(h.answerFor(answer("https://photos-a.test", "webauthn.create", ch), srv, "get", { challenge: ch })).toBe(false);
    expect(h.answerFor(answer("https://photos-a.test", "webauthn.get", ch, { crossOrigin: true }), srv, "get", { challenge: ch })).toBe(false);
    // another port, plain http, a name that only starts like it
    expect(h.answerFor(answer("https://photos-a.test:8443", "webauthn.get", ch), srv, "get", { challenge: ch })).toBe(false);
    expect(h.answerFor(answer("http://photos-a.test", "webauthn.get", ch), srv, "get", { challenge: ch })).toBe(false);
    expect(h.answerFor(answer("https://photos-a.test.evil.test", "webauthn.get", ch), srv, "get", { challenge: ch })).toBe(false);
    // nothing to check: never taken
    expect(h.answerFor({ id: "k" }, srv, "get", { challenge: ch })).toBe(false);
    expect(h.answerFor({ id: "k", response: { clientDataJSON: "not-json" } }, srv, "get", { challenge: ch })).toBe(false);
    expect(h.answerFor(answer("https://photos-a.test", "webauthn.get", ch), srv, "get", {})).toBe(false);
  });

  it("knows the server's origin as the browser writes it", () => {
    expect(h.originOf("https://Photos.Example.org/")).toBe("https://photos.example.org");
    expect(h.originOf("https://photos.example.org:443")).toBe("https://photos.example.org");
    expect(h.originOf("https://192.168.1.20:8443/x")).toBe("https://192.168.1.20:8443");
    expect(h.originOf("https://[fd00::1]:8443")).toBe("https://[fd00::1]:8443");
    expect(h.originOf("http://photos.example.org")).toBe("");
    expect(h.originOf("https://user@photos.example.org")).toBe("");
  });

  it("refuses an answer for another server even with the right state", async () => {
    const opened: string[] = [];
    const platform = { openURL: async (u: string) => { opened.push(u); }, onAppState: () => ({ remove() {} }), away() {} };
    const p = h.viaBrowserPasskey("https://photos-a.test", "get", { challenge: "QV9DSEFMTEVOR0U" }, platform);
    await new Promise((r) => setTimeout(r, 50));
    const frag = opened[0].split("#")[1];
    const state = JSON.parse(atob(frag.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((frag.length + 3) % 4))).state as string;
    h.passkeyReturned(`cipherfilm://passkey#s=${state}&a=${b64u(JSON.stringify(answer("https://photos-b.test", "webauthn.get", "Ql9DSEFMTEVOR0U")))}`);
    await expect(p).rejects.toThrow(/another site/);
  });
});
