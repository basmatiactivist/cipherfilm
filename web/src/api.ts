export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let csrf = "";

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

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) { sessionEnded(res, path); throw new ApiError(res.status, sentence(data?.error ?? "Something went wrong.")); }
  return data as T;
}

const FRIENDLY: Record<string, string> = {
  "invalid request": "That didn't work. Check what you entered and try again.",
  "server error": "The server had a problem. Wait a moment and try again.",
  "not found": "That couldn't be found. It may have been removed.",
};
export const sentence = (s: string): string => FRIENDLY[s] ?? (s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : s);

const RETRYABLE = new Set([0, 408, 429, 500, 502, 503, 504]);

/** PUT raw bytes (ciphertext) with a few retries; 4xx other than 408/429 fail immediately. */
export async function putBytes(path: string, bytes: Uint8Array, tries = 4): Promise<void> {
  let last: ApiError | undefined;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    let res: Response | undefined;
    try {
      res = await fetch(path, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": csrf }, body: bytes as BodyInit });
    } catch {
      last = new ApiError(0, "Can't reach the server. Check your connection and try again.");
      continue;
    }
    if (res.ok) return;
    sessionEnded(res, path);
    let msg = "Something went wrong.";
    try { msg = sentence((await res.json()).error ?? msg); } catch { /* no body */ }
    last = new ApiError(res.status, msg);
    if (!RETRYABLE.has(res.status)) break;
  }
  throw last!;
}

export async function getBytes(path: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) { sessionEnded(res, path); throw new ApiError(res.status, "Couldn't load this item."); }
  return new Uint8Array(await res.arrayBuffer());
}

/** POST JSON and take the answer as raw bytes (many thumbnails' ciphertext in one request). */
export async function postForBytes(path: string, body: unknown): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) { sessionEnded(res, path); throw new ApiError(res.status, "Couldn't load these items."); }
  return new Uint8Array(await res.arrayBuffer());
}
