// "Report a problem": a link to the GitHub issue form (.github/ISSUE_TEMPLATE/bug_report.yml), prefilled with this
// browser's details only when the person agrees to it in the dialog. The app sends nothing itself: the person's browser
// opens the link, and they see and can change every field on github.com before posting. Android and the Mac build the
// same link (mobile/src/report.ts, mac/Sources/CipherfilmCore/Report.swift); the field ids are the form's.

export const ISSUE_FORM = "https://github.com/basmatiactivist/cipherfilm/issues/new?template=bug_report.yml";

/** What goes into the form: exactly these fields, and exactly what the dialog shows (summary()). No server address,
 *  e-mail, names or anything about the library: the form is public. */
export interface ReportDetails {
  /** One of the form's "Which app?" options, word for word. */
  app: "Web";
  /** "2.3.0 (web)" */
  appVersion: string;
  /** "Firefox 140 · macOS" */
  device: string;
  /** The server's version, when known; not its address. */
  serverVersion?: string;
}

// Strict RFC 3986 escaping (encodeURIComponent leaves !'()* alone), so all three apps produce the same link; control
// characters go, and a length cap keeps an odd browser string from making the link too long for GitHub (414).
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
const enc = (s: string) => encodeURIComponent(clean(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** The link; without details it is only the empty form. */
export function reportUrl(d?: ReportDetails): string {
  if (!d) return ISSUE_FORM;
  const fields: [string, string | undefined][] = [["app", d.app], ["app_version", d.appVersion], ["device", d.device], ["server_version", d.serverVersion]];
  return ISSUE_FORM + fields.filter(([, v]) => v && clean(v)).map(([k, v]) => `&${k}=${enc(v!)}`).join("");
}

/** The line the dialog shows, built from the same fields the link carries. */
export function summary(d: ReportDetails): string {
  return [`Cipherfilm ${clean(d.appVersion)}`, clean(d.device), d.serverVersion && clean(d.serverVersion) ? `Server ${clean(d.serverVersion)}` : ""].filter(Boolean).join(" · ");
}

interface UAData { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean }

/** Browser and system, coarse: the major browser version and the system's name, nothing more. The low-entropy
 *  navigator.userAgentData where there is one (Chromium), else a short reading of the user agent (Firefox, Safari).
 *  Browsers freeze the system version in the user agent anyway, so it would only mislead. */
export function browserSummary(ua: string, data?: UAData): string {
  let browser = "";
  const brands = (data?.brands ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
  // Chromium lists itself next to the browser built on it: the other one is the name people know
  const brand = brands.find((b) => b.brand !== "Chromium") ?? brands[0];
  if (brand) browser = `${brand.brand.replace(/^Google /, "")} ${brand.version}`;
  else {
    const m = /\b(Edg|OPR|Firefox|FxiOS|CriOS|EdgiOS)\/(\d+)/.exec(ua) ?? (/Chrome\/(\d+)/.test(ua) ? ["", "Chrome", /Chrome\/(\d+)/.exec(ua)![1]] : null);
    const names: Record<string, string> = { Edg: "Edge", EdgiOS: "Edge", OPR: "Opera", FxiOS: "Firefox", CriOS: "Chrome" };
    if (m) browser = `${names[m[1]] ?? m[1]} ${m[2]}`;
    else if (/Safari\//.test(ua)) { const v = /Version\/(\d+(?:\.\d+)?)/.exec(ua); browser = v ? `Safari ${v[1]}` : "Safari"; }
    else browser = "Unknown browser";
  }
  let os = data?.platform ?? "";
  if (!os) {
    if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
    else if (/Android/.test(ua)) os = "Android";
    else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/CrOS/.test(ua)) os = "ChromeOS";
    else if (/Linux/.test(ua)) os = "Linux";
  }
  return os ? `${browser} · ${os}` : browser;
}

/** This browser's details, for the dialog and the link. */
export function thisBrowser(serverVersion?: string): ReportDetails {
  const nav = navigator as Navigator & { userAgentData?: UAData };
  return { app: "Web", appVersion: `${__APP_VERSION__} (web)`, device: browserSummary(nav.userAgent, nav.userAgentData), serverVersion: serverVersion || undefined };
}
