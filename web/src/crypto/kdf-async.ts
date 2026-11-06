import { deriveFromPassword, KdfParams } from "./kdf";

// Kept apart from kdf.ts: the worker imports kdf.ts, and must not pull in the code that creates the worker.
/** Same as deriveFromPassword, but off the main thread in browsers so the page stays responsive during Argon2. */
export async function deriveAsync(password: string, p: KdfParams): Promise<{ authKey: Uint8Array; kek: Uint8Array }> {
  // in Node (tests, the test-account script in mobile/dev, which runs without Vite and so without import.meta.env);
  // the build drops this branch, so no second copy of the sumo build lands next to the worker
  if ((import.meta as unknown as { env?: { MODE: string } }).env?.MODE !== "production" && typeof Worker === "undefined") return deriveFromPassword(await (await import("./sodium-sumo")).getSumo(), password, p);
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./kdf.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      w.terminate();
      e.data.ok ? resolve({ authKey: e.data.authKey, kek: e.data.kek }) : reject(new Error("key derivation failed"));
    };
    w.onerror = () => { w.terminate(); reject(new Error("key derivation failed")); };
    w.postMessage({ password, params: p });
  });
}
