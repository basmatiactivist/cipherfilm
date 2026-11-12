// Passkeys through the browser, for a server Android can't vouch for. Before an app may use a passkey of a domain,
// Google fetches that domain's /.well-known/assetlinks.json from the internet; a server only on a private network
// (Tailscale, a home LAN) is out of its reach, and Android refuses ("passkeys aren't supported for this app"). A
// browser checks the address itself, so for such a server the app opens the server's own /passkey page, as the Mac app
// does (web/src/screens.tsx PasskeyHandoff), and the answer comes back to this app's own address
// (cipherfilm://passkey#…, cipherfilm-test:// for a test build), which +native-intent.ts hands here.
// The options travel in the address's fragment, which the browser never sends to the server.
import { t } from "./i18n";

type J = Record<string, unknown>;
// Expo's native modules only when used: +native-intent.ts (and its unit tests in plain Node) load this module
const store = () => require("expo-secure-store") as typeof import("expo-secure-store");

const scheme = (): string => {
  try {
    const Constants = require("expo-constants").default as typeof import("expo-constants").default;
    const s = Constants.expoConfig?.scheme;
    return (Array.isArray(s) ? s[0] : s) || "cipherfilm";
  } catch { return "cipherfilm"; }
};
/** What the /passkey page is told to return to (a fixed list there, never an address from here). */
const appName = (): "android" | "android-test" => (scheme() === "cipherfilm-test" ? "android-test" : "android");

const PRIVATE_HOST = /(^|\.)(ts\.net|local|lan|home\.arpa|internal|localhost)$|^localhost$|^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^\[?(fc|fd|fe80)/i;
const failedKey = (host: string) => `passkey_browser_${host.replace(/[^a-z0-9.-]/gi, "_")}`;
const failed = new Set<string>();

/** The server's host name ("https://photos.example.org:8443/" is "photos.example.org"). */
export function hostOf(server: string): string {
  const m = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(server.trim());
  return m ? m[1].toLowerCase() : "";
}

/** Whether passkeys for this server go through the browser: a private network's name or address, or Android
 *  already refused it once on this phone. */
export async function viaBrowser(server: string): Promise<boolean> {
  const host = hostOf(server);
  if (!host) return false;
  if (PRIVATE_HOST.test(host) || failed.has(host)) return true;
  const v = await (async () => store().getItemAsync(failedKey(host)))().catch(() => null);
  if (v) failed.add(host);
  return !!v;
}

/** Android refused this server's passkeys (assetlinks out of reach): from now on the browser, on this phone. */
export function rememberBrowser(server: string) {
  const host = hostOf(server);
  if (!host) return;
  failed.add(host);
  (async () => store().setItemAsync(failedKey(host), "1"))().catch(() => {});
}

const b64u = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** The /passkey page's address with what to do and the options in the fragment. */
export function handoffUrl(server: string, op: "get" | "create", options: J): string {
  const base = server.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) throw new Error(t("Passkeys need the server's https address. Use a code instead."));
  return `${base}/passkey#${b64u(JSON.stringify({ op, options, app: appName() }))}`;
}

/** Whether an address that opened the app is the /passkey page's answer. */
export const isPasskeyReturn = (url: string): boolean => url.toLowerCase().startsWith(`${scheme()}://passkey`);

/** The answer in such an address: the passkey's JSON, or null when it was cancelled or failed. */
export function readReturn(url: string): J | null {
  const frag = url.split("#")[1] ?? "";
  if (!frag || frag.startsWith("error=")) return null;
  try {
    const v = JSON.parse(unb64u(frag));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as J) : null;
  } catch { return null; }
}

let waiting: { done: (url: string | null) => void } | null = null;

/** +native-intent.ts: the page sent its answer back. */
export function passkeyReturned(url: string) { waiting?.done(url); }

/** Opens the server's /passkey page in the browser and waits for its answer. Rejects when the person comes back
 *  without one (cancelled, or the browser didn't hand it back). */
export function viaBrowserPasskey(server: string, op: "get" | "create", options: J): Promise<J> {
  const url = handoffUrl(server, op, options);
  waiting?.done(null);
  // React Native only here, when it runs: the unit tests (plain Node) load this module through the sign-in
  const { AppState, Linking } = require("react-native") as typeof import("react-native");
  return new Promise<J>((resolve, reject) => {
    let left = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") { left = true; return; }
      // back in the app: the answer comes with this, or shortly after; nothing means it was left without one
      if (left) { clearTimeout(timer); timer = setTimeout(() => finish(null), 2500); }
    });
    const finish = (u: string | null) => {
      if (!waiting) return;
      waiting = null;
      clearTimeout(timer);
      sub.remove();
      const answer = u ? readReturn(u) : null;
      if (answer) resolve(answer); else reject(Object.assign(new Error(t("No passkey was used. Try again, or use a code instead.")), { code: "ERR_PASSKEY_CANCELLED" }));
    };
    waiting = { done: finish };
    (require("./autolock") as typeof import("./autolock")).expectAway(); // the browser for a moment: not a reason to lock
    Linking.openURL(url).catch(() => finish(null));
  });
}
