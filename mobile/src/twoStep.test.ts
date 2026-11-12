import { describe, expect, it } from "vitest";
import { cleanCode, codeProblem, codeReady, firstWay, groupSecret, methods, passkeyTrouble, pendingToken, totpUri, passkeyFor, serverHost } from "./twoStep";

// The answers of server/twofactor.go, as api.ts turns them into errors (status, code, the JSON body).
const err = (status: number, code: string, body: unknown = null) => Object.assign(new Error("x"), { status, code, body });

describe("two-step sign-in", () => {
  it("finds the pending token only in the password step's answer", () => {
    expect(pendingToken(err(401, "two_factor_required", { pending: "tok", expires_in: 300 }))).toBe("tok");
    expect(pendingToken(err(401, "", { error: "wrong e-mail or password" }))).toBeNull();
    expect(pendingToken(err(401, "two_factor_required", {}))).toBeNull();
    expect(pendingToken(err(429, "two_factor_required", { pending: "tok" }))).toBeNull();
    expect(pendingToken(new Error("offline"))).toBeNull();
    expect(pendingToken(null)).toBeNull();
  });

  it("tells a wrong code from an expired sign-in", () => {
    expect(codeProblem(err(401, "wrong_code"))).toBe("wrong");
    expect(codeProblem(err(403, "wrong_code"))).toBe("wrong"); // the Account checks answer 403
    expect(codeProblem(err(401, "two_factor_expired"))).toBe("expired");
    expect(codeProblem(err(429, ""))).toBe("other");
    expect(codeProblem(err(0, ""))).toBe("other");
  });

  it("tidies what is typed", () => {
    expect(cleanCode(" 123 456 ", false)).toBe("123456");
    expect(cleanCode("1234567", false)).toBe("123456");
    expect(codeReady("123456", false)).toBe(true);
    expect(codeReady("12345", false)).toBe(false);
    expect(cleanCode(" abcd-efgh-1234-5678 ", true)).toBe("abcd-efgh-1234-5678");
    expect(codeReady("abcd-efgh-1234-5678", true)).toBe(true);
    expect(codeReady("ABCDEFGH12345678", true)).toBe(true);
    expect(codeReady("abcd-efgh", true)).toBe(false);
    expect(groupSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
  });

  it("reads which second steps the account has, and starts with the right one", () => {
    expect(methods(err(401, "two_factor_required", { pending: "t", totp: false, passkey: true }))).toEqual({ totp: false, passkey: true });
    expect(methods(err(401, "two_factor_required", { pending: "t" }))).toEqual({ totp: true, passkey: false }); // an older server
    expect(codeProblem(err(401, "wrong_passkey"))).toBe("wrong");
    expect(firstWay({ totp: false, passkey: true }, true)).toBe("passkey");
    expect(firstWay({ totp: true, passkey: true }, true)).toBe("code");
    expect(firstWay({ totp: false, passkey: true }, false)).toBe("recovery"); // a passkey this phone can't use
    expect(firstWay({ totp: true, passkey: false }, true)).toBe("code");
  });

  it("tells why Android gave no passkey", () => {
    const n = (code: string, message = "") => Object.assign(new Error(message), { code });
    expect(passkeyTrouble(n("ERR_PASSKEY_CANCELLED"))).toBe("cancelled");
    expect(passkeyTrouble(n("ERR_PASSKEY_NONE"))).toBe("none");
    expect(passkeyTrouble(n("ERR_PASSKEY_UNSUPPORTED"))).toBe("unsupported");
    expect(passkeyTrouble(n("ERR_PASSKEY", "RP ID cannot be validated."))).toBe("server");
    expect(passkeyTrouble(err(409, "passkeys_unavailable"))).toBe("server");
    expect(passkeyTrouble(n("ERR_PASSKEY", "something else"))).toBe("other");
  });
});

describe("totpUri", () => {
  it("opens only an otpauth://totp/ address", () => {
    expect(totpUri("otpauth://totp/Cipherfilm:me%40x?secret=ABC&issuer=Cipherfilm")).toBe(true);
    for (const u of ["https://evil.example/", "otpauth://hotp/x", "intent://x#Intent;scheme=x;end", "cipherfilm://notice", "content://x", "", undefined]) expect(totpUri(u)).toBe(false);
  });
});

describe("passkeyFor", () => {
  const S = "https://photos.example.org:8443/";
  it("takes the server's own host or a parent domain of it", () => {
    expect(serverHost(S)).toBe("photos.example.org");
    expect(passkeyFor({ rpId: "photos.example.org" }, false, S)).toBe(true);
    expect(passkeyFor({ rpId: "Example.org" }, false, S)).toBe(true);
    expect(passkeyFor({ rp: { id: "photos.example.org", name: "Cipherfilm" } }, true, S)).toBe(true);
  });
  it("refuses another site, a bare top-level domain, a look-alike or a missing id", () => {
    expect(passkeyFor({ rpId: "bank.example" }, false, S)).toBe(false);
    expect(passkeyFor({ rpId: "org" }, false, S)).toBe(false);
    expect(passkeyFor({ rpId: "ample.org" }, false, S)).toBe(false);
    expect(passkeyFor({ rpId: "photos.example.org.evil.example" }, false, S)).toBe(false);
    expect(passkeyFor({}, false, S)).toBe(false);
    expect(passkeyFor({ rpId: "photos.example.org" }, true, S)).toBe(false); // a new passkey names it in rp.id
    expect(passkeyFor({ rp: { id: "bank.example" } }, true, S)).toBe(false);
    expect(passkeyFor({ rpId: "photos.example.org" }, false, "")).toBe(false);
  });
});
