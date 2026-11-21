// A custom review as a story (app/review/[id].tsx, StoryPlayer.tsx): the slides are the shared ones
// (@memories/custom reviewSlides: the cover, the photos year by year, the end); here how long each stays and what it
// shows, timed like the year in review (recapStory.ts): a year's photos one after the other like a month's.
import type { ReviewSlide } from "@memories/custom";
import { PHOTO_MS, SLIDE_MS } from "./recapStory";

export function reviewSlideMs(s: ReviewSlide<unknown>): number {
  return s.kind === "ryear" ? Math.max(SLIDE_MS, s.photos.length * PHOTO_MS) : SLIDE_MS;
}

export function reviewSlideItems<T>(s: ReviewSlide<T>): T[] {
  return s.kind === "rcover" ? [s.item] : s.kind === "ryear" ? s.photos : [];
}
