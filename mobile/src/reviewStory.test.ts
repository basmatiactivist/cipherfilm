import { describe, expect, it } from "vitest";
import { reviewSlides, type ReviewItem } from "@memories/custom";
import { reviewSlideItems, reviewSlideMs } from "./reviewStory";
import { PHOTO_MS, SLIDE_MS } from "./recapStory";

const photo = (id: string, y: number): ReviewItem => ({ id, kind: "image", created_at: 0, has_thumb: true, meta: { capture_ts: new Date(y, 5, 1).getTime() } });
const r = { id: "a", name: "Dogs", query: "dog", every: "week" as const, count: 12, notify: false, created: 1, updated: 1 };

describe("a custom review as a story", () => {
  it("cover, each year's photos, end; a year with many photos stays longer, like a month in the year in review", () => {
    const picked = [photo("a", 2020), photo("b", 2020), photo("c", 2020), photo("d", 2020), photo("e", 2021)];
    const s = reviewSlides(r, picked, 40);
    expect(s.map((x) => x.kind)).toEqual(["rcover", "ryear", "ryear", "rend"]);
    expect(s.map(reviewSlideMs)).toEqual([SLIDE_MS, Math.max(SLIDE_MS, 4 * PHOTO_MS), SLIDE_MS, SLIDE_MS]);
    expect(s.map((x) => reviewSlideItems(x).map((i) => i.id))).toEqual([[s[0].kind === "rcover" ? s[0].item.id : ""], ["a", "b", "c", "d"], ["e"], []]);
  });
});
