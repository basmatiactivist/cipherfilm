import { describe, expect, it } from "vitest";
import { setLang } from "./i18n";
import { cleanCode, codeProblem, codeReady, firstWay, groupSecret, methods, passkeyTrouble, pendingToken, stepButtons, stepError, stepNeeded, usesRecovery, withStep } from "./twoStep";

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

  describe("the second step for a change to the account", () => {
    it("adds only the second step that was given", () => {
      const body = { current_auth: "proof" };
      expect(withStep(body)).toEqual({ current_auth: "proof" });
      expect(withStep(body, null)).toEqual({ current_auth: "proof" });
      expect(withStep(body, { code: "" })).toEqual({ current_auth: "proof" });
      expect(withStep(body, { code: "  " })).toEqual({ current_auth: "proof" });
      expect(withStep(body, { code: "123456" })).toEqual({ current_auth: "proof", code: "123456" });
      expect(withStep(body, { code: "ABCD-EFGH-IJKL-MNOP" })).toEqual({ current_auth: "proof", code: "ABCD-EFGH-IJKL-MNOP" });
      expect(withStep(body, { passkey: { id: "k" } })).toEqual({ current_auth: "proof", passkey: { id: "k" } });
      expect(withStep(body, { code: "123456", passkey: { id: "k" } })).toEqual({ current_auth: "proof", passkey: { id: "k" } });
      expect(body).toEqual({ current_auth: "proof" }); // the body itself stays as it was
    });

    it("knows when the server wants a second step", () => {
      expect(stepNeeded(err(403, "second_step_required"))).toBe(true);
      expect(stepNeeded(err(403, ""))).toBe(false); // a wrong password
      expect(stepNeeded(err(403, "wrong_code"))).toBe(false);
      expect(stepNeeded(err(409, "second_step_required"))).toBe(false);
      expect(stepNeeded(new Error("offline"))).toBe(false);
      expect(stepNeeded(null)).toBe(false);
    });

    it("offers the ways the account has", () => {
      const both = { totp: true, passkey: true };
      expect(stepButtons(both, false)).toEqual({ passkey: true, code: true });
      expect(stepButtons(both, true)).toEqual({ passkey: false, code: true });
      expect(stepButtons({ totp: false, passkey: true }, false)).toEqual({ passkey: true, code: false });
      expect(stepButtons({ totp: false, passkey: true }, true)).toEqual({ passkey: false, code: true });
      expect(stepButtons({ totp: true, passkey: false }, false)).toEqual({ passkey: false, code: true });
      // only a passkey this phone can't use: a recovery code is the way
      expect(usesRecovery({ totp: false, passkey: false }, false)).toBe(true);
      expect(stepButtons({ totp: false, passkey: false }, false)).toEqual({ passkey: false, code: true });
      expect(usesRecovery({ totp: true, passkey: false }, false)).toBe(false);
    });

    it("words a refused second step", () => {
      setLang("en");
      expect((stepError(err(403, "wrong_code")) as Error).message).toBe("That code isn't right. Try again.");
      expect((stepError(err(403, "wrong_passkey")) as Error).message).toBe("That passkey wasn't accepted. Try again.");
      expect((stepError(err(403, "second_step_required")) as Error).message).toMatch(/^Your account uses two-step sign-in/);
      const other = err(429, "");
      expect(stepError(other)).toBe(other);
      setLang("de");
      expect((stepError(err(403, "wrong_code")) as Error).message).toBe("Dieser Code stimmt nicht. Versuchen Sie es noch einmal.");
      setLang("en");
    });
  });
});
