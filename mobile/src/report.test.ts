import { describe, expect, it } from "vitest";
import { ISSUE_FORM, details, deviceLine, reportUrl, summary } from "./report";

const query = (url: string) => new URL(url).searchParams;
const pixel = { Release: "15", Version: 35, Manufacturer: "Google", Model: "Pixel 9" };

describe("report link", () => {
  const play = details({ play: true, version: "2.3.0", constants: pixel, serverVersion: "2.3.0" });

  it("fills in the form's fields, escaped, and shows the same values", () => {
    expect(play).toEqual({ app: "Android (Google Play)", appVersion: "2.3.0 (Google Play)", device: "Android 15 · Google Pixel 9", serverVersion: "2.3.0" });
    expect(summary(play)).toBe("Cipherfilm 2.3.0 (Google Play) · Android 15 · Google Pixel 9 · Server 2.3.0");
    const url = reportUrl(play);
    expect(url).toBe(ISSUE_FORM + "&app=Android%20%28Google%20Play%29&app_version=2.3.0%20%28Google%20Play%29&device=Android%2015%20%C2%B7%20Google%20Pixel%209&server_version=2.3.0");
    const q = query(url);
    expect([...q.keys()]).toEqual(["template", "app", "app_version", "device", "server_version"]);
    expect(q.get("app")).toBe("Android (Google Play)");
  });

  it("names the GitHub build, and leaves out what it doesn't know", () => {
    const gh = details({ play: false, constants: {} });
    expect(gh).toEqual({ app: "Android (GitHub APK)", appVersion: "unknown (GitHub APK)", device: "Android", serverVersion: undefined });
    expect([...query(reportUrl(gh)).keys()]).toEqual(["template", "app", "app_version", "device"]);
    expect(summary(gh)).toBe("Cipherfilm unknown (GitHub APK) · Android");
  });

  it("escapes what would break the query, and drops control characters", () => {
    const odd = details({ play: true, version: "2.3.0", constants: { ...pixel, Model: "X&server_version=1#y\u0000" } });
    const q = query(reportUrl(odd));
    expect(q.get("device")).toBe("Android 15 · Google X&server_version=1#y");
    expect(q.getAll("server_version")).toEqual([]);
  });

  it("takes the server's version only as a plain release number", () => {
    const at = (serverVersion: string) => details({ play: true, version: "2.3.0", constants: pixel, serverVersion });
    for (const v of ["2.8.0", "2.8.0-rc.1", "dev"]) {
      expect(query(reportUrl(at(v))).get("server_version")).toBe(v);
      expect(summary(at(v))).toBe(`Cipherfilm 2.3.0 (Google Play) · Android 15 · Google Pixel 9 · Server ${v}`);
    }
    const hidden = "2.8.0" + [..."u=a@b"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    for (const v of [hidden, "2.8.0\u200b", "2.8.0\u202e", "2.8.0\u2028x", "2.8.0 extra", "2.8.0-" + "a".repeat(21), "v2.8.0", "2.8.0\n", " 2.8.0"]) {
      expect(query(reportUrl(at(v))).getAll("server_version")).toEqual([]);
      expect(summary(at(v))).toBe("Cipherfilm 2.3.0 (Google Play) · Android 15 · Google Pixel 9");
    }
  });

  it("opens only the empty form without details", () => {
    expect(reportUrl()).toBe("https://github.com/basmatiactivist/cipherfilm/issues/new?template=bug_report.yml");
    expect([...query(reportUrl()).keys()]).toEqual(["template"]);
  });

  it("carries nothing but the four fields, whatever else the caller has", () => {
    const leaky = { ...play, email: "someone@example.org", server: "https://photos.example.org" } as typeof play;
    expect(reportUrl(leaky)).not.toMatch(/example|someone|photos/);
  });
});

describe("device line", () => {
  it("names the maker once", () => {
    expect(deviceLine(pixel)).toBe("Android 15 · Google Pixel 9");
    expect(deviceLine({ Release: "14", Manufacturer: "samsung", Model: "SM-S921B" })).toBe("Android 14 · Samsung SM-S921B");
    expect(deviceLine({ Release: "14", Manufacturer: "Xiaomi", Model: "Xiaomi 14" })).toBe("Android 14 · Xiaomi 14");
    expect(deviceLine({ Version: 34 })).toBe("Android (API 34)");
  });
});
