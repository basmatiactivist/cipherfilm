import { describe, expect, it } from "vitest";
import { cleanCode, codeReady, codesFile, groupSecret, qrFor } from "./twofactor";

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
});
