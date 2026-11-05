import { getSumo } from "./sodium-sumo";
import { deriveFromPassword, KdfParams } from "./kdf";

self.onmessage = async (e: MessageEvent<{ password: string; params: KdfParams }>) => {
  try {
    const s = await getSumo();
    const { authKey, kek } = deriveFromPassword(s, e.data.password, e.data.params);
    (self as any).postMessage({ ok: true, authKey, kek }, [authKey.buffer, kek.buffer]);
  } catch (err) {
    (self as any).postMessage({ ok: false, error: String(err) });
  }
};
