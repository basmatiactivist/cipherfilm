// Puts a caption band above a raw phone screenshot for the Play listing.
//
//   node docs/play/graphics/frame.mjs <raw.png> <out.png> "<caption>" [--size 1080x1920] [--sub "<second line>"]
//
// Output: an opaque 24-bit PNG (Play rejects alpha in screenshots) of the given size (default 1080x1920, 9:16).
// Top: a warm-paper band with the caption in the brand serif (ink). Below: the screenshot, scaled to fit, centred,
// with rounded corners and a hairline frame. Needs sharp (see render.mjs for where it is looked up).
import { loadSharp } from "./render.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const size = opt("--size", "1080x1920");
const sub = opt("--sub", "");
const [input, output, caption] = args;
if (!input || !output || !caption) {
  console.error('usage: node frame.mjs <raw.png> <out.png> "<caption>" [--size 1080x1920] [--sub "<second line>"]');
  process.exit(2);
}
const [W, H] = size.split("x").map(Number);
if (!(W >= 320 && H >= 320 && W <= 3840 && H <= 3840 && Math.max(W, H) <= 2 * Math.min(W, H))) {
  console.error("size must be 320..3840 px per side with the long side at most twice the short side (Play rule)");
  process.exit(2);
}

const sharp = loadSharp();
const PAPER = "#FAF7F2", INK = "#1F2A33", MUTED = "#4B5963", RULE = "#CFC6B6";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const s = W / 1080;                       // everything below is designed for 1080 px wide
const band = Math.round(H * 0.2);         // caption band height
const pad = Math.round(64 * s);

// Caption: pango wraps it to the band width.
const markup = `<span foreground="${INK}" font_family="Georgia, serif" size="${Math.round(60 * s)}pt">${esc(caption)}</span>` +
  (sub ? `\n<span foreground="${MUTED}" font_family="Helvetica Neue, Helvetica, Arial, sans-serif" size="${Math.round(30 * s)}pt">${esc(sub)}</span>` : "");
const text = await sharp({ text: { text: markup, rgba: true, width: W - 2 * pad, align: "centre", dpi: 72, wrap: "word", spacing: Math.round(14 * s) } }).png().toBuffer();
const tm = await sharp(text).metadata();

// Screenshot: fit into the area under the band, keep aspect ratio, round the corners, add a hairline.
const areaW = W - 2 * pad, areaH = H - band - Math.round(40 * s);
const raw = sharp(input).flatten({ background: "#ffffff" });
const rm = await raw.metadata();
const k = Math.min(areaW / rm.width, areaH / rm.height);
const sw = Math.round(rm.width * k), sh = Math.round(rm.height * k);
const r = Math.round(36 * s);
const mask = Buffer.from(`<svg width="${sw}" height="${sh}"><rect width="${sw}" height="${sh}" rx="${r}" ry="${r}"/></svg>`);
const shot = await raw.resize(sw, sh).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
const sx = Math.round((W - sw) / 2), sy = band;
const frame = Buffer.from(`<svg width="${W}" height="${H}"><rect x="${sx - 1}" y="${sy - 1}" width="${sw + 2}" height="${sh + 2}" rx="${r + 1}" ry="${r + 1}" fill="none" stroke="${RULE}" stroke-width="2"/></svg>`);

await sharp({ create: { width: W, height: H, channels: 3, background: PAPER } })
  .composite([
    { input: text, left: Math.round((W - tm.width) / 2), top: Math.max(0, Math.round((band - tm.height) / 2)) },
    { input: frame, left: 0, top: 0 },
    { input: shot, left: sx, top: sy },
  ])
  .flatten({ background: PAPER }).removeAlpha()
  .png({ compressionLevel: 9 })
  .toFile(output);

const om = await sharp(output).metadata();
console.log(`${output}: ${om.width}x${om.height}, channels=${om.channels}, alpha=${om.hasAlpha}`);
