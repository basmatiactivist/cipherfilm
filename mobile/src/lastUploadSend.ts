// Sends this phone's newest upload time to its session once (deviceIdle.ts sendLastUpload), after the library loaded
// following an unlock: from the items this phone uploaded itself (ownUploads.ts) that are in the library. Remembers
// which session it was sent for in the app's private files; deleted at sign-out.
import { File, Paths } from "expo-file-system";
import { api } from "./api";
import { onSignOut, session } from "./session";
import { ownUploads } from "./ownUploads";
import { newestOwnUpload, sendLastUpload } from "./deviceIdle";
import { onLibraryLoaded } from "./libraryStore";

const MARK = () => new File(Paths.document, "last-upload-sent.json");
let running = false;
let triedFor = ""; // once per app start and session: an older server without the route isn't asked at every load

export async function backfillLastUpload(userId: string, items: { id: string; created_at: number }[]): Promise<void> {
  const me = session().me;
  if (running || !me || me.user.id !== userId || !me.session_id || triedFor === me.session_id) return;
  running = true;
  triedFor = me.session_id;
  try {
    await sendLastUpload({
      sessionId: me.session_id,
      demo: me.demo,
      sentFor: async () => {
        try { const f = MARK(); return f.exists ? (JSON.parse(await f.text()) as { session?: string }).session : undefined; } catch { return undefined; }
      },
      markSent: async (s) => { await MARK().write(JSON.stringify({ session: s })); },
      newest: async () => newestOwnUpload(items, await ownUploads(userId)),
      post: (at) => api("POST", "/api/me/sessions/current/last-upload", { at }),
    });
  } catch { /* an older server, or offline: tried again after the next load */ } finally {
    running = false;
  }
}

onLibraryLoaded((userId, list) => { backfillLastUpload(userId, list).catch(() => {}); });
onSignOut(() => { try { const f = MARK(); if (f.exists) f.delete(); } catch { /* best effort */ } });
