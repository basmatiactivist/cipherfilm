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
}

/** Key material lives only in this module's memory: a reload or tab close locks the library. */
export const mem: { masterKey: Uint8Array | null; me: Me | null } = { masterKey: null, me: null };
