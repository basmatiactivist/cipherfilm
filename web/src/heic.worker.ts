import lib from "libheif-js/wasm-bundle";

/** Decodes a HEIC/HEIF file to RGBA. Runs under a CSP that forbids network access (see server/main.go). */
self.onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    const img = new lib.HeifDecoder().decode(e.data)[0];
    if (!img) throw new Error("unreadable HEIC");
    const width = img.get_width(), height = img.get_height();
    if (width * height > 256_000_000) throw new Error("image is too large to preview"); // before allocating width*height*4 bytes
    const data = new Uint8ClampedArray(width * height * 4);
    await new Promise<void>((res, rej) => img.display({ data, width, height }, (r) => (r ? res() : rej(new Error("HEIC decode failed")))));
    (self as any).postMessage({ ok: true, width, height, buffer: data.buffer }, [data.buffer]);
  } catch (err) {
    (self as any).postMessage({ ok: false, error: String(err) });
  }
};
