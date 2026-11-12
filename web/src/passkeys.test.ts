import { describe, expect, it } from "vitest";
import { creationOptions, handoffReturn, passkeyFailure, readHandoff, requestOptions, suggestName, toB64u } from "./passkeys";

// The conversions between the server's WebAuthn JSON and what the browser takes, and the Mac app's hand-off.
const bytes = (b: BufferSource) => Array.from(new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer));

describe("passkey options", () => {
  it("turns the server's base64url fields into bytes, keeping the rest", () => {
    const c = creationOptions({ challenge: "AQID", rp: { id: "photos.test", name: "Cipherfilm" }, user: { id: "_-8", name: "a@x.org", displayName: "a@x.org" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [{ type: "public-key", id: "BAU" }] });
    expect(bytes(c.challenge)).toEqual([1, 2, 3]);
    expect(bytes(c.user.id)).toEqual([255, 239]);
    expect(bytes(c.excludeCredentials![0].id)).toEqual([4, 5]);
    expect(c.rp.id).toBe("photos.test");
    const r = requestOptions({ challenge: "AQID", rpId: "photos.test", allowCredentials: [{ type: "public-key", id: "BAU", transports: ["internal"] }] });
    expect(bytes(r.challenge)).toEqual([1, 2, 3]);
    expect(bytes(r.allowCredentials![0].id)).toEqual([4, 5]);
    expect(r.allowCredentials![0].transports).toEqual(["internal"]);
    expect(requestOptions({ challenge: "AQID" }).allowCredentials).toBeUndefined();
  });

  it("encodes base64url without padding", () => {
    expect(toB64u(new Uint8Array([255, 239]))).toBe("_-8");
    expect(toB64u(new Uint8Array([1, 2, 3]).buffer)).toBe("AQID");
  });

  it("says in plain words why no passkey came", () => {
    expect(passkeyFailure(Object.assign(new Error("x"), { name: "NotAllowedError" })).message).toMatch(/No passkey was used/);
    expect(passkeyFailure(Object.assign(new Error("x"), { name: "InvalidStateError" })).message).toMatch(/already added/);
    expect(passkeyFailure(new Error("other")).message).toBe("other");
  });

  it("suggests a name from the device", () => {
    expect(suggestName("Mozilla/5.0 (Linux; Android 16; Pixel 9)")).toBe("Passkey on Android");
    expect(suggestName("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)")).toBe("Passkey on Mac");
    expect(suggestName("curl")).toBe("Passkey");
  });
});

describe("the apps' hand-off", () => {
  it("reads what the app sends in the fragment, and nothing else", () => {
    const h = { op: "get", options: { challenge: "AQID", rpId: "photos.test" } };
    const frag = "#" + toB64u(new TextEncoder().encode(JSON.stringify(h)));
    expect(readHandoff(frag)).toEqual({ ...h, app: "mac" }); // an older Mac app names no app
    expect(readHandoff("#" + toB64u(new TextEncoder().encode(JSON.stringify({ op: "steal", options: { challenge: "x" } }))))).toBeNull();
    expect(readHandoff("#not-base64-json")).toBeNull();
    expect(readHandoff("")).toBeNull();
  });

  it("answers to the Mac app's own address", () => {
    const back = handoffReturn({ id: "k" });
    expect(back.startsWith("cipherfilm-mac://passkey#")).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(back.split("#")[1].replace(/-/g, "+").replace(/_/g, "/") + "=="), (c) => c.charCodeAt(0))))).toEqual({ id: "k" });
    expect(handoffReturn(null)).toBe("cipherfilm-mac://passkey#error=cancelled");
  });

  const frag = (x: unknown) => "#" + toB64u(new TextEncoder().encode(JSON.stringify(x)));
  it("knows which app asked, and only the known ones", () => {
    const base = { op: "create", options: { challenge: "AQID", rp: { id: "photos.test" } } };
    for (const app of ["mac", "android", "android-test"] as const) expect(readHandoff(frag({ ...base, app }))).toEqual({ ...base, app });
    for (const app of ["ios", "", "cipherfilm://evil", null, 1, {}, "__proto__", "toString"]) expect(readHandoff(frag({ ...base, app }))).toBeNull();
  });

  it("answers each app at its own fixed address", () => {
    expect(handoffReturn(null, "cancelled", "mac")).toBe("cipherfilm-mac://passkey#error=cancelled");
    expect(handoffReturn(null, "cancelled", "android")).toBe("cipherfilm://passkey#error=cancelled");
    expect(handoffReturn(null, "no passkey", "android-test")).toBe("cipherfilm-test://passkey#error=no%20passkey");
    expect(handoffReturn({ id: "k" }, "", "android")).toBe("cipherfilm://passkey#" + toB64u(new TextEncoder().encode(JSON.stringify({ id: "k" }))));
    // a return address in the hand-off is never used
    const h = readHandoff(frag({ op: "get", options: { challenge: "x" }, app: "android", return: "https://evil.test/" }))!;
    expect(h).toEqual({ op: "get", options: { challenge: "x" }, app: "android" });
    expect(handoffReturn(null, "", h.app)).toBe("cipherfilm://passkey#error=cancelled");
  });
});
