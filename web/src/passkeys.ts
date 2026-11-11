// Passkeys as the second step of a sign-in (server/passkeys.go): never instead of the password, which derives the
// keys; only instead of the code from an authenticator app. The server sends WebAuthn options as JSON (binary fields
// base64url); the browser wants ArrayBuffers, and the answer goes back as JSON again.
import { api } from "./api";

type J = Record<string, any>;

export interface Passkey { id: string; name: string; rp_id: string; here: boolean; created_at: number; last_used_at: number }

const fromB64u = (s: string): Uint8Array<ArrayBuffer> => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};

export const toB64u = (buf: ArrayBuffer | ArrayBufferView): string => {
  const u = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const descriptors = (l?: J[]) => l?.map((d) => ({ ...d, id: fromB64u(d.id) }));

/** The server's creation options as navigator.credentials.create wants them. */
export function creationOptions(o: J): PublicKeyCredentialCreationOptions {
  return { ...o, challenge: fromB64u(o.challenge), user: { ...o.user, id: fromB64u(o.user.id) }, excludeCredentials: descriptors(o.excludeCredentials) } as unknown as PublicKeyCredentialCreationOptions;
}

/** The server's request options as navigator.credentials.get wants them. */
export function requestOptions(o: J): PublicKeyCredentialRequestOptions {
  return { ...o, challenge: fromB64u(o.challenge), allowCredentials: descriptors(o.allowCredentials) } as unknown as PublicKeyCredentialRequestOptions;
}

/** A new or used passkey's answer, as JSON for the server. */
export function credentialJSON(c: PublicKeyCredential): J {
  const r = c.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  const response: J = { clientDataJSON: toB64u(r.clientDataJSON) };
  if ("attestationObject" in r && r.attestationObject) {
    response.attestationObject = toB64u(r.attestationObject);
    if (typeof r.getTransports === "function") response.transports = r.getTransports();
  } else {
    response.authenticatorData = toB64u(r.authenticatorData);
    response.signature = toB64u(r.signature);
    if (r.userHandle) response.userHandle = toB64u(r.userHandle);
  }
  return { id: c.id, rawId: toB64u(c.rawId), type: c.type, response, clientExtensionResults: {}, authenticatorAttachment: c.authenticatorAttachment ?? undefined };
}

/** Whether this browser can use passkeys here: WebAuthn, in a secure context, and the page reached by a name. */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && typeof window.PublicKeyCredential === "function" && !!navigator.credentials &&
    !/^\[|^\d+\.\d+\.\d+\.\d+$/.test(location.hostname);
}

/** Why the browser's passkey dialog ended without a passkey, in plain words. */
export function passkeyFailure(e: unknown): Error {
  const n = (e as { name?: string } | null)?.name;
  if (n === "NotAllowedError" || n === "AbortError") return new Error("No passkey was used. Try again, or use a code instead.");
  if (n === "InvalidStateError") return new Error("This passkey is already added.");
  if (n === "SecurityError") return new Error("Passkeys work only when Cipherfilm is opened by its https address.");
  return e instanceof Error ? e : new Error(String(e));
}

/** Asks the browser for a passkey's answer to the server's request options. */
export async function getPasskey(options: J): Promise<J> {
  let c: Credential | null;
  try {
    c = await navigator.credentials.get({ publicKey: requestOptions(options) });
  } catch (e) {
    throw passkeyFailure(e);
  }
  if (!c) throw new Error("No passkey was used. Try again, or use a code instead.");
  return credentialJSON(c as PublicKeyCredential);
}

/** Asks the browser to make a passkey for the server's creation options. */
export async function createPasskey(options: J): Promise<J> {
  let c: Credential | null;
  try {
    c = await navigator.credentials.create({ publicKey: creationOptions(options) });
  } catch (e) {
    throw passkeyFailure(e);
  }
  if (!c) throw new Error("No passkey was made.");
  return credentialJSON(c as PublicKeyCredential);
}

// ---- the account's passkeys ----

/** What a change to two-step sign-in sends: the password proof and the second step, a code or a passkey's answer. */
export interface Proof { current_auth: string; code?: string; passkey?: J }

export const list = () => api<{ passkeys: Passkey[]; available: boolean; max: number }>("GET", "/api/me/passkeys");
export const rename = (id: string, name: string) => api("PATCH", `/api/me/passkeys/${encodeURIComponent(id)}`, { name });
export const remove = (id: string, proof: Proof) => api<{ two_factor: boolean }>("DELETE", `/api/me/passkeys/${encodeURIComponent(id)}`, proof);

/** A passkey's answer for a change that needs a second step (the signed-in session's own challenge). */
export async function proofPasskey(): Promise<J> {
  const { options } = await api<{ options: J }>("POST", "/api/me/2fa/passkey", {});
  return getPasskey(options);
}

/** Starts adding a passkey (checks the password and the second step): the options for the browser. */
export const beginAdd = async (proof: Proof): Promise<J> => (await api<{ options: J }>("POST", "/api/me/passkeys/register/begin", proof)).options;

/** Makes the passkey (call it right on a tap) and stores it; returns the recovery codes when it is the account's first
 *  second step (two-step sign-in is on now). */
export async function finishAdd(options: J, name: string): Promise<string[] | null> {
  const credential = await createPasskey(options);
  const r = await api<{ recovery_codes?: string[] }>("POST", "/api/me/passkeys/register/finish", { name, credential });
  return r.recovery_codes ?? null;
}

/** A name for a new passkey, from what this browser runs on; the person can change it. */
export function suggestName(ua: string): string {
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `Passkey on ${os}` : "Passkey";
}

// ---- the Mac app's hand-off (docs/THREAT_MODEL.md, "Passkeys") ----

/** What the Mac app hands to /passkey in the address's fragment (never sent to the server): what to do and the options. */
export interface Handoff { op: "get" | "create"; options: J }

export function readHandoff(hash: string): Handoff | null {
  try {
    const h = JSON.parse(new TextDecoder().decode(fromB64u(hash.replace(/^#/, ""))));
    if ((h?.op === "get" || h?.op === "create") && h.options && typeof h.options.challenge === "string") return h as Handoff;
  } catch { /* not a hand-off */ }
  return null;
}

/** Where the answer goes back to the Mac app: its own address, which only the sign-in window waiting for it receives. */
export const handoffReturn = (answer: J | null, error = ""): string =>
  "cipherfilm-mac://passkey#" + (answer ? toB64u(new TextEncoder().encode(JSON.stringify(answer))) : "error=" + encodeURIComponent(error || "cancelled"));
