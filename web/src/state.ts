import type { KdfParams } from "./crypto/kdf";

export interface Me {
  user: { id: string; email: string; role: "admin" | "user"; nsfw?: boolean };
  /** this browser in the device list, and the device that computes the search index (docs/SEARCH.md) */
  session_id?: string;
  indexer?: string;
  csrf: string;
  kdf: KdfParams;
  wrapped_master_pw: string;
  wrapped_privkey: string;
  pubkey: string;
  server_version?: string;
  /** the map tab's base map styles (light, dark: tried in order); absent when the server turned the map off (MAP_STYLE) */
  map?: { light: string[]; dark: string[] };
  /** the server's public demo login (DEMO_ACCOUNTS): it reads and searches, every change is refused */
  demo?: boolean;
}

/** Key material lives only in this module's memory: a reload or tab close locks the library. */
export const mem: { masterKey: Uint8Array | null; me: Me | null } = { masterKey: null, me: null };

/** Drops the master key and overwrites its bytes. The reference goes first: work still running compares mem.masterKey
 *  with the key it started with and stops (SignedOut); requests on their way were aborted before (dropRequests). */
export function dropMasterKey() {
  const k = mem.masterKey;
  mem.masterKey = null;
  k?.fill(0);
}
