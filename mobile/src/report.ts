// "Report a problem": a link to the GitHub issue form (.github/ISSUE_TEMPLATE/bug_report.yml), prefilled with this
// phone's details only when the person agrees to it in the dialog. The app sends nothing itself: the browser opens the
// link, and the person sees and can change every field on github.com before posting (so Google Play's Data safety
// form is unaffected: no data leaves through the app). The web app and the Mac build the same link (web/src/report.ts,
// mac/Sources/CipherfilmCore/Report.swift); the field ids are the form's.

export const ISSUE_FORM = "https://github.com/basmatiactivist/cipherfilm/issues/new?template=bug_report.yml";

/** What goes into the form: exactly these fields, and exactly what the dialog shows (summary()). No server address,
 *  e-mail, names or anything about the library: the form is public. */
export interface ReportDetails {
  /** One of the form's "Which app?" options, word for word. */
  app: "Android (Google Play)" | "Android (GitHub APK)";
  /** "2.3.0 (Google Play)" */
  appVersion: string;
  /** "Android 15 · Google Pixel 9" */
  device: string;
  /** The server's version, when known; not its address. */
  serverVersion?: string;
}

// Strict RFC 3986 escaping (encodeURIComponent leaves !'()* alone), so all three apps produce the same link; control
// characters go, and a length cap keeps an odd model name from making the link too long for GitHub (414).
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
const enc = (s: string) => encodeURIComponent(clean(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** The link; without details it is only the empty form. */
export function reportUrl(d?: ReportDetails): string {
  if (!d) return ISSUE_FORM;
  const fields: [string, string | undefined][] = [["app", d.app], ["app_version", d.appVersion], ["device", d.device], ["server_version", d.serverVersion]];
  return ISSUE_FORM + fields.filter(([, v]) => v && clean(v)).map(([k, v]) => `&${k}=${enc(v!)}`).join("");
}

/** The line the dialog shows, built from the same fields the link carries. Not translated: it is what lands in the
 *  (English) form. */
export function summary(d: ReportDetails): string {
  return [`Cipherfilm ${clean(d.appVersion)}`, clean(d.device), d.serverVersion && clean(d.serverVersion) ? `Server ${clean(d.serverVersion)}` : ""].filter(Boolean).join(" · ");
}

/** "Android 15 · Google Pixel 9" from Android's build constants. The maker goes first unless the model already says
 *  it ("Pixel 9" needs "Google"; "Redmi Note 13" from Xiaomi doesn't get it twice). */
export function deviceLine(c: { Release?: string; Version?: number; Manufacturer?: string; Model?: string }): string {
  const os = c.Release ? `Android ${c.Release}` : c.Version ? `Android (API ${c.Version})` : "Android";
  const maker = (c.Manufacturer ?? "").trim();
  const model = (c.Model ?? "").trim();
  const Maker = maker ? maker[0].toUpperCase() + maker.slice(1) : "";
  const phone = !model ? Maker : !maker || model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${Maker} ${model}`;
  return phone ? `${os} · ${phone}` : os;
}

export function details(p: { play: boolean; version?: string; constants: Parameters<typeof deviceLine>[0]; serverVersion?: string }): ReportDetails {
  return {
    app: p.play ? "Android (Google Play)" : "Android (GitHub APK)",
    appVersion: `${p.version || "unknown"} (${p.play ? "Google Play" : "GitHub APK"})`,
    device: deviceLine(p.constants),
    serverVersion: p.serverVersion || undefined,
  };
}

/** This phone's details. Read when asked, not at import: the unit tests (plain Node) load this module. */
export function thisPhone(serverVersion?: string): ReportDetails {
  const { Platform } = require("react-native") as typeof import("react-native");
  const { isPlayBuild } = require("./store") as typeof import("./store");
  let version: string | undefined;
  try { version = (require("../modules/cf-native/src/CfNativeModule").default as { appVersion(): { name: string } }).appVersion().name; } catch { /* "unknown" */ }
  return details({ play: isPlayBuild(), version, constants: Platform.constants as { Release?: string; Manufacturer?: string; Model?: string }, serverVersion });
}
