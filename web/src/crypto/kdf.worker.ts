import { getSumo } from "./sodium-sumo";
import { deriveFromPassword, KdfParams } from "./kdf";

self.onmessage = async (e: MessageEvent<{ password: string; params: KdfParams }>) => {
  // a dedicated worker only hears from the page that created it (origin empty); refuse anything else
  if (e.origin && e.origin !== self.location.origin) return;
  try {
    if (typeof e.data?.password !== "string" || !e.data.params) throw new Error("bad request");
    const s = await getSumo();
    const { authKey, kek } = deriveFromPassword(s, e.data.password, e.data.params);
    (self as any).postMessage({ ok: true, authKey, kek }, [authKey.buffer, kek.buffer]);
  } catch (err) {
    (self as any).postMessage({ ok: false, error: String(err) });
  }
};
