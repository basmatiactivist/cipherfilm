import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { cleanCode, codeReady, codesFile, groupSecret, needsStep, qrFor, stepError, stepFields, totpUri } from "./twofactor";

describe("two-step sign-in helpers", () => {
  it("takes codes as people type them", () => {
    expect(cleanCode(" 123 456 ")).toBe("123456");
    expect(codeReady("123 456", false)).toBe(true);
    expect(codeReady("12345", false)).toBe(false);
    expect(codeReady("12345a", false)).toBe(false);
    expect(codeReady("abcd-1234-efgh-5678", true)).toBe(true);
    expect(codeReady("ABCD 1234 EFGH 5678", true)).toBe(true);
    expect(codeReady("abcd-1234", true)).toBe(false);
  });
  it("groups the key in fours", () => {
    expect(groupSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    expect(groupSecret("ABCDE")).toBe("ABCD E");
  });
  it("draws the QR code locally, with a quiet zone", () => {
    const q = qrFor("otpauth://totp/Cipherfilm:a%40b.org?secret=JBSWY3DPEHPK3PXP&issuer=Cipherfilm");
    expect(q.size).toBeGreaterThanOrEqual(21 + 8);
    expect(q.d.startsWith("M4 4h1v1h-1z")).toBe(true);
  });
  it("writes the codes file", () => {
    const f = codesFile("a@x.org", ["aaaa-bbbb-cccc-dddd", "eeee-ffff-gggg-hhhh"]);
    expect(f).toContain("a@x.org");
    expect(f).toContain("aaaa-bbbb-cccc-dddd\neeee-ffff-gggg-hhhh");
  });
  it("sends only the second step that was given", () => {
    expect(stepFields()).toEqual({});
    expect(stepFields({})).toEqual({});
    expect(stepFields({ code: "  " })).toEqual({});
    expect(stepFields({ code: " abcd-efgh-jkmn-pqrs " })).toEqual({ code: "abcd-efgh-jkmn-pqrs" });
    expect(stepFields({ code: "123456", passkey: { id: "k" } })).toEqual({ passkey: { id: "k" } });
  });
  it("says the second step's refusals plainly", () => {
    const required = new ApiError(403, "This account uses two-step sign-in.", { code: "second_step_required" });
    expect(needsStep(required)).toBe(true);
    expect(needsStep(new ApiError(403, "That password isn't right.", { error: "that password isn't right" }))).toBe(false);
    expect(needsStep(new ApiError(401, "x", { code: "second_step_required" }))).toBe(false);
    expect((stepError(required) as Error).message).toMatch(/^Your account uses two-step sign-in/);
    expect((stepError(new ApiError(403, "x", { code: "wrong_code" })) as Error).message).toMatch(/^That code isn't right/);
    expect((stepError(new ApiError(403, "x", { code: "wrong_passkey" })) as Error).message).toMatch(/^That passkey wasn't accepted/);
    const pw = new ApiError(403, "That password isn't right.", {});
    expect(stepError(pw)).toBe(pw);
    const many = new ApiError(429, "Too many attempts, try later.", {});
    expect(stepError(many)).toBe(many);
  });
});

describe("totpUri", () => {
  it("accepts only an otpauth://totp/ address", () => {
    expect(totpUri("otpauth://totp/Cipherfilm:me%40x?secret=ABC&issuer=Cipherfilm")).toBe(true);
    expect(totpUri("OTPAUTH://TOTP/x")).toBe(true);
    for (const u of ["https://evil.example/", "otpauth://hotp/x", "intent://x#Intent;end", "file:///etc/passwd", "javascript:alert(1)", " otpauth://totp/x", "", null, 5]) expect(totpUri(u)).toBe(false);
  });
});
