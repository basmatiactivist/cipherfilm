// The server's JSON API, as the web client uses it. The session is the server's cookie, which Android's cookie store
// keeps; the CSRF token comes with /api/me and lives in memory. expo/fetch sends the ciphertext bytes natively.
import { fetch } from "expo/fetch";
import { Platform } from "react-native";
import { t } from "./i18n";

let base = "";
let csrf = "";
let onSessionEnded: () => void = () => {};
let onRevoked: () => void = () => {};

/** How this phone shows in the account's device list (web, Account › Devices); only a label. */
// ASCII only: a header value with any other character makes the request fail before it is sent
const DEVICE = `${String((Platform.constants as { Model?: string }).Model ?? "Android").replace(/[^\x20-\x7e]/g, "").slice(0, 60)} (Android app)`;

export class ApiError extends Error {
  /** for logs: what the network layer said (a timeout, a refused connection), never shown as the message */
  constructor(public status: number, message: string, public detail = "", public code = "") {
    super(message);
  }
}
const why = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200);

export const setServer = (origin: string) => { base = origin.replace(/\/+$/, ""); };
export const server = () => base;
export const setCsrf = (t: string) => { csrf = t; };
export const csrfToken = () => csrf;
/** Where a background job sends its requests, with the CSRF token of its own /api/me: the app's server and token stay
 *  as they are, whatever the job does. The session cookie is still the one in Android's cookie store. */
export interface Remote { base: string; csrf: string }
export const remote = (origin: string): Remote => ({ base: origin.replace(/\/+$/, ""), csrf: "" });
const here = (): Remote => ({ base, csrf });

export const whenSessionEnds = (f: () => void) => { onSessionEnded = f; };
/** The person signed this phone out from another device: everything it keeps for the account goes. */
export const whenRevoked = (f: () => void) => { onRevoked = f; };

// a request that gets no answer fails instead of waiting forever (uploads get longer for a 4 MB part)
const JSON_TIMEOUT = 20_000;
const BYTES_TIMEOUT = 120_000;
const within = (ms: number) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
/** A time limit that can be moved: a JSON answer gets JSON_TIMEOUT to start, then as long as bytes to arrive (a page
 *  of the library is up to 4 MB, which a slow mobile connection doesn't bring in 20 seconds). */
function limit(ms: number) {
  const c = new AbortController();
  let t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, move(to: number) { clearTimeout(t); t = setTimeout(() => c.abort(), to); }, end() { clearTimeout(t); } };
}

// in the phone's language when they are made (the language can change while the app runs)
const offline = () => t("Can't connect to the server. Check your connection and try again.");
const friendly = (s: string): string | undefined => ({
  "invalid request": t("That didn't work. Check what you entered and try again."),
  "server error": t("The server had a problem. Wait a moment and try again."),
  "not found": t("That couldn't be found. It may have been removed."),
} as Record<string, string>)[s];
const sentence = (s: string): string => friendly(s) ?? (s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : s);

function ended(res: Response, path: string, to: Remote) {
  // only an answer from the app's own server ends its session
  if (res.status !== 401 || path.startsWith("/api/auth/") || to.base !== base) return;
  if (res.headers.get("X-CF-Session") === "revoked") onRevoked();
  else if (path !== "/api/me") onSessionEnded();
}

export async function api<T = any>(method: string, path: string, body?: unknown, to: Remote = here()): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", "X-CF-Device": DEVICE };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && to.csrf) headers["X-CSRF-Token"] = to.csrf;
  let res: Response;
  const time = limit(JSON_TIMEOUT);
  try {
    res = await fetch(to.base + path, { method, credentials: "include", headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: time.signal });
  } catch (e) {
    time.end();
    throw new ApiError(0, offline(), `${method} ${path.replace(/[0-9a-f]{32}/g, ":id")}: ${why(e)}`);
  }
  time.move(BYTES_TIMEOUT);
  // a body cut off (the time limit, a dropped connection) or that isn't JSON (a proxy's or captive portal's page) is a
  // failed request, never an answer of null that the caller would read from
  let text = "";
  try { text = await res.text(); } catch (e) { if (res.ok) throw new ApiError(0, offline(), `${method} ${path.replace(/[0-9a-f]{32}/g, ":id")}: body ${why(e)}`); } finally { time.end(); }
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) { ended(res, path, to); throw new ApiError(res.status, sentence(data?.error ?? t("Something went wrong.")), "", data?.code ?? ""); }
  // a GET always answers with an object or a list; other methods may answer with nothing
  if ((text && data === null) || (method === "GET" && (data === null || typeof data !== "object"))) {
    throw new ApiError(0, offline(), `${method} ${path.replace(/[0-9a-f]{32}/g, ":id")}: ${res.status}, not a JSON answer`);
  }
  return data as T;
}

const RETRYABLE = new Set([0, 408, 429, 500, 502, 503, 504]);

/** PUT ciphertext, retrying network drops and busy servers with backoff (about a minute and a half in all: a phone
 *  changing networks or reconnecting its VPN needs that long); other 4xx fail at once. */
export async function putBytes(path: string, bytes: Uint8Array, to: Remote = here(), tries = 8): Promise<void> {
  let last: ApiError | undefined;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (i - 1), 30_000)));
    let res: Response;
    try {
      res = await fetch(to.base + path, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": to.csrf }, body: bytes as unknown as ArrayBuffer, signal: within(BYTES_TIMEOUT) });
    } catch (e) {
      last = new ApiError(0, offline(), `PUT ${path.replace(/[0-9a-f]{32}/g, ":id")}: ${why(e)}`);
      continue;
    }
    if (res.ok) return;
    ended(res, path, to);
    let msg = t("Something went wrong.");
    try { msg = sentence((await res.json()).error ?? msg); } catch { /* no body */ }
    last = new ApiError(res.status, msg);
    if (!RETRYABLE.has(res.status)) break;
  }
  throw last!;
}

export async function getBytes(path: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(base + path, { credentials: "include", signal: within(BYTES_TIMEOUT) });
  } catch (e) {
    throw new ApiError(0, offline(), `GET ${path.replace(/[0-9a-f]{32}/g, ":id")}: ${why(e)}`);
  }
  if (!res.ok) { ended(res, path, here()); throw new ApiError(res.status, t("Couldn't load this item.")); }
  return new Uint8Array(await res.arrayBuffer());
}

/** POST JSON and take the answer as raw bytes (many thumbnails' ciphertext in one request). */
export async function postForBytes(path: string, body: unknown): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(base + path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body), signal: within(BYTES_TIMEOUT) });
  } catch (e) {
    throw new ApiError(0, offline(), `POST ${path.replace(/[0-9a-f]{32}/g, ":id")}: ${why(e)}`);
  }
  if (!res.ok) { ended(res, path, here()); throw new ApiError(res.status, t("Couldn't load these items.")); }
  return new Uint8Array(await res.arrayBuffer());
}
