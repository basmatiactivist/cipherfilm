import { b64, getSodium } from "./crypto/sodium";
import { BLOB_LIMIT, streamingAvailable } from "./player";
import { fetchOriginal, Item } from "./items";
import { dedupe, safeName } from "./names";

const clickDownload = (href: string, name?: string) => {
  const a = document.createElement("a");
  a.href = href;
  if (name) a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
};

/** Hands a download job (including the item keys) to the Service Worker, which streams the result to the browser's download manager. */
async function viaWorker(kind: "file" | "zip", name: string, items: Item[]): Promise<void> {
  const s = await getSodium();
  const token = b64(s, s.randombytes_buf(16));
  const entries = items.map((it) => ({
    id: it.id, key: b64(s, it.itemKey!), size: it.size, count: it.segment_count, mime: "",
    name: it.meta?.name ?? "item", mtime: it.meta?.capture_ts ?? Date.now(),
  }));
  await new Promise<void>((res, rej) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => rej(new Error("Couldn't start the download. Try again.")), 4000);
    ch.port1.onmessage = () => { clearTimeout(t); res(); };
    navigator.serviceWorker.controller!.postMessage({ type: "job", token, job: { kind, name, entries } }, [ch.port2]);
  });
  clickDownload(`/sw/dl/${token}`);
}

const tooBig = () => new Error("Too large to download in this browser. Select fewer items or use another browser.");

export async function downloadOriginal(it: Item): Promise<void> {
  const name = it.meta?.name ?? "download";
  if (await streamingAvailable()) return viaWorker("file", name, [it]);
  if (it.size > BLOB_LIMIT) throw tooBig();
  const url = URL.createObjectURL(await fetchOriginal(it));
  clickDownload(url, safeName(name));
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The photo as edited (turned, cropped), drawn here from the original at full size, with its date and place in the
 *  EXIF (edit/apply.ts). The original stays available (downloadOriginal). */
export async function downloadEdited(it: Item): Promise<void> {
  const { editedCopy } = await import("./edit/apply");
  const { editedName } = await import("./edit/edit");
  const url = URL.createObjectURL(await editedCopy(it));
  clickDownload(url, safeName(editedName(it.meta?.name ?? "photo")));
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Several items as one ZIP (stored, not compressed: photos and videos don't shrink). */
export async function downloadItems(items: Item[], zipName: string): Promise<void> {
  const ok = items.filter((i) => !i.broken);
  if (ok.length === 0) throw new Error("Nothing here can be downloaded.");
  const name = safeName(zipName).replace(/\.zip$/i, "") + ".zip";
  if (await streamingAvailable()) return viaWorker("zip", name, ok);
  if (ok.reduce((n, i) => n + i.size, 0) > BLOB_LIMIT) throw tooBig();
  const names = dedupe(ok.map((i) => i.meta?.name ?? "item"));
  const files: { name: string; lastModified: number; input: Blob }[] = [];
  for (let i = 0; i < ok.length; i++) files.push({ name: names[i], lastModified: ok[i].meta?.capture_ts ?? Date.now(), input: await fetchOriginal(ok[i]) });
  const { downloadZip } = await import("client-zip");
  const url = URL.createObjectURL(await downloadZip(files).blob());
  clickDownload(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
