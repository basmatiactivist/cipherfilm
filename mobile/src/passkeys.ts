// Passkeys as the second step of a sign-in (server/passkeys.go), through Android's Credential Manager (Passkeys.kt).
// Never instead of the password, which derives the keys: only instead of the code from the authenticator app.
import N from "../modules/cf-native/src/CfNativeModule";
import { api, server } from "./api";
import { passkeyFor, passkeyTrouble } from "./twoStep";
import { rememberBrowser, viaBrowser, viaBrowserPasskey } from "./passkeyHandoff";
import { t } from "./i18n";

type J = Record<string, unknown>;
export interface Passkey { id: string; name: string; rp_id: string; here: boolean; created_at: number; last_used_at: number }
/** What a change to two-step sign-in sends: the password proof and the second step, a code or a passkey's answer. */
export interface Proof { current_auth: string; code?: string; passkey?: J }

export const passkeysSupported = (): boolean => { try { return N.passkeysSupported(); } catch { return false; } };

/** The passkey's trouble in plain words. */
export function passkeyError(e: unknown): Error {
  switch (passkeyTrouble(e)) {
    case "cancelled": return new Error(t("No passkey was used. Try again, or use a code instead."));
    case "none": return new Error(t("This phone has no passkey for this server. Use a code instead."));
    case "unsupported": return new Error(t("Passkeys need Android 14 or newer. Use a code instead."));
    case "server": return new Error(t("Android couldn't check this server for passkeys: it must be reachable from the internet by its https name. Use a code instead."));
    default: {
      // never the bridge's own wording ("Call to function 'CfNative.passkeyGet' has been rejected. → Caused by: …")
      const m = (e instanceof Error ? e.message : String(e)).split(/Caused by:\s*/).pop()?.replace(/\s*\[androidx[^\]]*\]/g, "").trim();
      return new Error(m ? t("The passkey didn't work ({reason}). Try again, or use a code instead.", { reason: m }) : t("The passkey didn't work. Try again, or use a code instead."));
    }
  }
}

/** Refuses a request for another site's passkey (twoStep.ts, passkeyFor). */
function ownServer(options: J, create: boolean) {
  if (!passkeyFor(options, create, server())) throw new Error(t("This server asked for a passkey of another site. Use a code instead."));
}

/** Android's Credential Manager, or the browser for a server Android can't vouch for (passkeyHandoff.ts); a server
 *  Android refuses is remembered and tried once more through the browser at once. */
async function passkey(op: "get" | "create", options: J): Promise<J> {
  ownServer(options, op === "create");
  const srv = server();
  if (await viaBrowser(srv)) {
    try { return await viaBrowserPasskey(srv, op, options); } catch (e) { throw passkeyError(e); }
  }
  try {
    return JSON.parse(op === "get" ? await N.passkeyGet(JSON.stringify(options)) : await N.passkeyCreate(JSON.stringify(options))) as J;
  } catch (e) {
    if (passkeyTrouble(e) !== "server") throw passkeyError(e);
    rememberBrowser(srv);
    try { return await viaBrowserPasskey(srv, op, options); } catch (e2) { throw passkeyError(e2); }
  }
}

export const getPasskey = (options: J): Promise<J> => passkey("get", options);
const createPasskey = (options: J): Promise<J> => passkey("create", options);

export const list = () => api<{ passkeys: Passkey[]; available: boolean }>("GET", "/api/me/passkeys");
export const remove = (id: string, proof: Proof) => api<{ two_factor: boolean }>("DELETE", `/api/me/passkeys/${encodeURIComponent(id)}`, proof);

/** A passkey's answer for a change that needs a second step (the signed-in session's own challenge). */
export async function proofPasskey(): Promise<J> {
  const { options } = await api<{ options: J }>("POST", "/api/me/2fa/passkey", {});
  return getPasskey(options);
}

/** Adds a passkey; returns the recovery codes when it is the account's first second step (two-step sign-in is on now). */
export async function add(proof: Proof, name: string): Promise<string[] | null> {
  const { options } = await api<{ options: J }>("POST", "/api/me/passkeys/register/begin", proof);
  const credential = await createPasskey(options);
  const r = await api<{ recovery_codes?: string[] }>("POST", "/api/me/passkeys/register/finish", { name, credential });
  return r.recovery_codes ?? null;
}
