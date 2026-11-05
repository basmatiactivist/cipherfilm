// Renders the Play store graphics from the SVG sources next to this file.
// Usage: node docs/play/graphics/render.mjs   (needs sharp; found in web/node_modules, the website's node_modules or $SHARP_FROM)
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
export function loadSharp() {
  const roots = [process.env.SHARP_FROM, join(here, "../../../web/"), join(homedir(), "Desktop/cipherfilm-site/"), here + "/"].filter(Boolean);
  for (const r of roots) {
    try { return createRequire(join(r, "package.json"))("sharp"); } catch {}
  }
  throw new Error("sharp not found; set SHARP_FROM to a folder whose node_modules contains sharp");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sharp = loadSharp();
  // App icon: 512x512, 32-bit PNG (RGBA). The source is opaque paper, so alpha is 255 everywhere; Play masks the corners.
  await sharp(join(here, "icon.svg"), { density: 72 * 512 / 1024 }).resize(512, 512).ensureAlpha()
    .png({ compressionLevel: 9 }).toFile(join(here, "icon-512.png"));
  // Feature graphic: 1024x500, 24-bit PNG without alpha.
  for (const [src, out] of [["feature-graphic-en.svg", "feature-graphic-1024x500.png"], ["feature-graphic-de.svg", "feature-graphic-de-1024x500.png"]]) {
    await sharp(join(here, src), { density: 72 }).resize(1024, 500).flatten({ background: "#FAF7F2" }).removeAlpha()
      .png({ compressionLevel: 9 }).toFile(join(here, out));
  }
  for (const f of ["icon-512.png", "feature-graphic-1024x500.png", "feature-graphic-de-1024x500.png"]) {
    const m = await sharp(join(here, f)).metadata();
    console.log(f, `${m.width}x${m.height}`, `channels=${m.channels}`, `alpha=${m.hasAlpha}`, `${m.size ?? ""}`);
  }
}
