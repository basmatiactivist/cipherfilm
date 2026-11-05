/** Decodes an image and makes the thumbnail and preview JPEGs off the main thread, so a big import does not freeze the page. */
interface Req { id: number; file: File; thumbPx: number; previewPx: number; maxPixels: number }

async function encode(bmp: ImageBitmap, maxPx: number, quality: number): Promise<Uint8Array> {
  const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; // JPEG has no alpha
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, file, thumbPx, previewPx, maxPixels } = e.data;
  try {
    const bmp = await createImageBitmap(file);
    try {
      if (bmp.width * bmp.height > maxPixels) throw new Error("image is too large to preview");
      const thumb = await encode(bmp, thumbPx, 0.82);
      const preview = await encode(bmp, previewPx, 0.85);
      (self as any).postMessage({ id, ok: true, width: bmp.width, height: bmp.height, thumb, preview }, [thumb.buffer, preview.buffer]);
    } finally {
      bmp.close();
    }
  } catch (err) {
    (self as any).postMessage({ id, ok: false, error: String(err) });
  }
};
