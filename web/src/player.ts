import { getSodium, b64 } from "./crypto/sodium";
import { playMime } from "./sw-range";
import type { Item } from "./items";

/** Fallback when no Service Worker is available: decrypt the whole file in memory, up to this size. */
export const BLOB_LIMIT = 512 * 1024 * 1024;

interface Params { key: string; size: number; count: number; mime: string }
const params = new Map<string, Params>();

// The Service Worker asks the page for an item's key when it needs one (e.g. after the worker was restarted).
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "need-key" && e.ports[0]) e.ports[0].postMessage(params.get(e.data.id) ?? null);
  });
}

/** True when a Service Worker is registered and controlling this page, so /sw/stream/ URLs work. */
export async function streamingAvailable(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error("service worker timed out")), ms));
    await Promise.race([navigator.serviceWorker.register("/sw.js"), timeout(5000)]);
    await Promise.race([navigator.serviceWorker.ready, timeout(5000)]); // never resolves when workers are blocked
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise<void>((r) => navigator.serviceWorker.addEventListener("controllerchange", () => r(), { once: true })),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
    }
    return !!navigator.serviceWorker.controller;
  } catch {
    return false;
  }
}

/** Hands the item's key to the in-memory table the worker reads from, and returns the stream URL. */
export async function prepareStream(it: Item): Promise<string> {
  const s = await getSodium();
  params.set(it.id, { key: b64(s, it.itemKey!), size: it.size, count: it.segment_count, mime: playMime(it.meta?.mime ?? "", it.meta?.name ?? "") });
  return `/sw/stream/${it.id}`;
}

export function forgetStream(id: string) { params.delete(id); }

export function clearPlayer() {
  params.clear();
  navigator.serviceWorker?.controller?.postMessage({ type: "clear" });
}
