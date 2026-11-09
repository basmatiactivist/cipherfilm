// Photo, video or other: at upload from the file, and for a listed item from its encrypted, authenticated
// metadata (library.ts), never from the server's plain `kind`, which a malicious server could change.
export const kindOf = (f: { mime: string; name: string }): "image" | "video" | "other" =>
  f.mime.startsWith("video/") || /\.(mp4|mov|m4v|3gp|webm)$/i.test(f.name) ? "video"
    : f.mime.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif|dng)$/i.test(f.name) ? "image" : "other";
