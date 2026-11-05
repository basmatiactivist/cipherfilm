import { describe, expect, test } from "vitest";
import { attachment, dedupe, safeName } from "./names";

describe("names", () => {
  test("safeName strips paths, control characters and leading dots", () => {
    expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd"); // slashes replaced and leading dots dropped, never a path
    expect(safeName("a/b\\c:d.jpg")).toBe("a_b_c_d.jpg");
    expect(safeName("\u0000\n.hidden")).toBe("hidden");
    expect(safeName("   ")).toBe("file");
    expect(safeName("x".repeat(500)).length).toBe(200);
    expect(safeName("../x")).not.toContain("/");
  });
  test("safeName neutralises bidi overrides, Windows device names and trailing dots", () => {
    expect(safeName("photo\u202Egpj.exe")).toBe("photogpj.exe");
    expect(safeName("CON.txt")).toBe("_CON.txt");
    expect(safeName("nul")).toBe("_nul");
    expect(safeName("report. . ")).toBe("report");
    expect(safeName("a\u200bb\u200d\ufeffc\u061c.jpg")).toBe("abc.jpg");
    expect(safeName("x".repeat(199) + " .jpg")).toBe("x".repeat(199)); // no trailing space after the cut
    expect(safeName(42)).toBe("file");
  });
  test("dedupe keeps every file, case-insensitively", () => {
    expect(dedupe(["a.jpg", "a.jpg", "A.JPG", "b", "b"])).toEqual(["a.jpg", "a (1).jpg", "A (2).JPG", "b", "b (1)"]);
  });
  test("attachment header is safe for quotes and non-ASCII", () => {
    const h = attachment('we"ird é.jpg');
    expect(h).toContain('filename="we_ird _.jpg"');
    expect(h).toContain("filename*=UTF-8''we_ird%20%C3%A9.jpg");
    expect(h).not.toMatch(/[\r\n]/);
  });
});
