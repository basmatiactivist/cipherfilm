import { describe, expect, it } from "vitest";
import { kindOf, kindOfMeta } from "./media";

// An item's kind comes from its encrypted, authenticated metadata by the same rule as at upload (items.ts), never
// from the server's plain `kind`: a malicious server could otherwise send a photo's own bytes to the video player.
describe("the kind of an item", () => {
  it("follows the encrypted metadata's mime type, else the file name", () => {
    expect(kindOfMeta({ mime: "image/jpeg", name: "a.jpg" })).toBe("image");
    expect(kindOfMeta({ mime: "video/mp4", name: "a.mp4" })).toBe("video");
    expect(kindOfMeta({ mime: "", name: "IMG_1.HEIC" })).toBe("image");
    expect(kindOfMeta({ mime: "application/octet-stream", name: "clip.mov" })).toBe("video");
    expect(kindOfMeta({ mime: "application/pdf", name: "doc.pdf" })).toBe("other");
  });
  it("is the same rule the upload used", () => {
    for (const [type, name] of [["image/png", "x.png"], ["video/quicktime", "x.mov"], ["", "x.heif"], ["text/plain", "x.txt"]])
      expect(kindOfMeta({ mime: type, name })).toBe(kindOf({ type, name }));
  });
});
