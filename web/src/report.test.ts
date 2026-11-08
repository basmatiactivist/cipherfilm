import { describe, expect, it } from "vitest";
import { ISSUE_FORM, browserSummary, reportUrl, summary } from "./report";

const query = (url: string) => new URL(url).searchParams;

describe("report link", () => {
  const d = { app: "Web" as const, appVersion: "2.3.0 (web)", device: "Firefox 140 · macOS", serverVersion: "2.3.0" };

  it("fills in the form's fields, escaped, and shows the same values", () => {
    const url = reportUrl(d);
    expect(url).toBe(ISSUE_FORM + "&app=Web&app_version=2.3.0%20%28web%29&device=Firefox%20140%20%C2%B7%20macOS&server_version=2.3.0");
    const q = query(url);
    expect([...q.keys()]).toEqual(["template", "app", "app_version", "device", "server_version"]);
    expect(q.get("device")).toBe("Firefox 140 · macOS");
    expect(summary(d)).toBe("Cipherfilm 2.3.0 (web) · Firefox 140 · macOS · Server 2.3.0");
  });

  it("escapes what would break the query, and drops control characters", () => {
    const q = query(reportUrl({ ...d, device: "a&b=c#d+e?\n" }));
    expect(q.get("device")).toBe("a&b=c#d+e?");
    expect([...q.keys()]).toHaveLength(5);
  });

  it("opens only the empty form without details", () => {
    expect(reportUrl()).toBe("https://github.com/basmatiactivist/cipherfilm/issues/new?template=bug_report.yml");
    expect([...query(reportUrl()).keys()]).toEqual(["template"]);
  });

  it("leaves out an unknown server version", () => {
    const { serverVersion: _, ...rest } = d;
    expect([...query(reportUrl(rest)).keys()]).not.toContain("server_version");
    expect(summary(rest)).toBe("Cipherfilm 2.3.0 (web) · Firefox 140 · macOS");
  });

  it("carries nothing but the four fields, whatever else the caller has", () => {
    // a caller holding the session by mistake: the extra properties don't make it into the link
    const leaky = { ...d, email: "someone@example.org", server: "https://photos.example.org" } as typeof d;
    const url = reportUrl(leaky);
    expect(url).not.toMatch(/example|someone|photos/);
    expect([...query(url).keys()]).toEqual(["template", "app", "app_version", "device", "server_version"]);
  });
});

describe("browser summary", () => {
  it("names browser and system coarsely", () => {
    expect(browserSummary("", { brands: [{ brand: "Not)A;Brand", version: "8" }, { brand: "Chromium", version: "142" }, { brand: "Google Chrome", version: "142" }], platform: "macOS" })).toBe("Chrome 142 · macOS");
    expect(browserSummary("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox 140 · macOS");
    expect(browserSummary("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1")).toBe("Safari 18.1 · iOS");
    expect(browserSummary("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0")).toBe("Edge 142 · Windows");
    expect(browserSummary("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36")).toBe("Chrome 142 · Linux");
  });
});
