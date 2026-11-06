export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let csrf = "";

/** A request of a session this tab has since locked or left: its answer is dropped quietly, never shown or used. */
export class Dropped extends Error {
  constructor() {
    super("Stopped: the library was locked or signed out.");
  }
}

// Every request runs under the current session's signal. Lock and sign-out abort them all at once: a late answer can't
// land after the keys are gone, and a slow download doesn't hold the connection the next sign-in needs.
let session = new AbortController();
export function dropRequests(): void {
  session.abort();
  session = new AbortController();
}

/** A 401 on anything but sign-in means the session ended: the app returns to the sign-in screen. */
const sessionEnded = (res: Response, path: string) => {
  // signed out from another device (Account › Devices): this browser deletes what it keeps, as at sign-out
  if (res.status === 401 && res.headers.get("X-CF-Session") === "revoked" && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event("cf-session-revoked"));
    return;
  }
  if (res.status === 401 && path.startsWith("/api/") && !path.startsWith("/api/auth/") && !path.startsWith("/api/setup") && path !== "/api/me" && !path.startsWith("/api/invites/")) {
    window.dispatchEvent(new Event("cf-session-ended"));
  }
};
export const setCsrf = (t: string): void => {
  csrf = t;
};

/** opts.timeout: a request that must outlive the session (sign-out tells the server) gets its own deadline instead. */
export async function api<T = any>(method: string, path: string, body?: unknown, opts?: { timeout: number; keepalive?: boolean }): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
  const signal = opts ? AbortSignal.timeout(opts.timeout) : session.signal;
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      keepalive: opts?.keepalive,
    });
    text = await res.text();
  } catch {
    // an answer cut off (a reload, a lost connection) is a failure, never an empty success
    if (signal.aborted && !opts) throw new Dropped();
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (signal.aborted && !opts) throw new Dropped();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new ApiError(0, "Couldn't read the server's answer. Try again.");
  }
  if (!res.ok) { sessionEnded(res, path); throw new ApiError(res.status, sentence(data?.error ?? "Something went wrong.")); }
  return data as T;
}

const FRIENDLY: Record<string, string> = {
  "invalid request": "That didn't work. Check what you entered and try again.",
  "server error": "The server had a problem. Try again in a moment.",
  "not found": "Not found. It may have been deleted.",
};
export const sentence = (s: string): string => FRIENDLY[s] ?? (s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : s);

const RETRYABLE = new Set([0, 408, 429, 500, 502, 503, 504]);

/** PUT raw bytes (ciphertext) with a few retries; 4xx other than 408/429 fail immediately. */
export async function putBytes(path: string, bytes: Uint8Array, tries = 4): Promise<void> {
  let last: ApiError | undefined;
  const signal = session.signal;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    if (signal.aborted) throw new Dropped(); // no retry for a session that is gone
    let res: Response | undefined;
    try {
      res = await fetch(path, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": csrf }, body: bytes as BodyInit, signal });
    } catch {
      if (signal.aborted) throw new Dropped();
      last = new ApiError(0, "Can't reach the server. Check your connection and try again.");
      continue;
    }
    if (signal.aborted) throw new Dropped();
    if (res.ok) return;
    sessionEnded(res, path);
    let msg = "Something went wrong.";
    try { msg = sentence((await res.json()).error ?? msg); } catch { /* no body */ }
    last = new ApiError(res.status, msg);
    if (!RETRYABLE.has(res.status)) break;
  }
  throw last!;
}

/** Reads a binary answer under the session's signal (see dropRequests). */
async function bytes(signal: AbortSignal, path: string, init: RequestInit, failed: string): Promise<Uint8Array> {
  try {
    const res = await fetch(path, { ...init, credentials: "same-origin", signal });
    if (signal.aborted) throw new Dropped();
    if (!res.ok) { sessionEnded(res, path); throw new ApiError(res.status, failed); }
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (signal.aborted) throw new Dropped();
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
}

export const getBytes = (path: string): Promise<Uint8Array> => bytes(session.signal, path, {}, "Couldn't load this item.");

/** POST JSON and take the answer as raw bytes (many thumbnails' ciphertext in one request). */
export const postForBytes = (path: string, body: unknown): Promise<Uint8Array> =>
  bytes(session.signal, path, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) }, "Couldn't load these items.");
