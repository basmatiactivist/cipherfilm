// The library's first screen appears only once its pictures are decoded (Gallery.tsx): the list arrives before the
// thumbnails, and a grid of empty tiles in the meantime looks broken. Until then the grid loads, invisible, under the
// loading badge. This decides when the badge goes: when every thumbnail of the first screen as it is NOW was shown,
// or after `max` at the latest, counted once from the first list.
//
// The list changes while it waits (the server's list after the cached one, a first sync after an update): the
// thumbnails waited for are worked out again each time, so one pushed off the first screen (never drawn, so never
// shown) doesn't hold the badge, and the deadline keeps running. Before, a new list cancelled the deadline and kept
// waiting for the old first screen: after an update the badge stayed for minutes.

export interface VeilItem { id: string; has_thumb: boolean; broken?: boolean }

export class Veil {
  private seen = new Set<string>();
  private waiting = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  lifted = false;

  constructor(private readonly lift: () => void, private readonly max: number) {}

  /** The items on the first screen, at every change of the list. */
  update(first: readonly VeilItem[]) {
    if (this.lifted) return;
    this.timer ??= setTimeout(() => this.done(), this.max);
    this.waiting = new Set(first.filter((it) => it.has_thumb && !it.broken && !this.seen.has(it.id)).map((it) => it.id));
    if (!this.waiting.size) this.done();
  }

  /** A tile shows its thumbnail (or gave up on it). */
  shown(id: string) {
    this.seen.add(id);
    if (!this.lifted && this.timer && this.waiting.delete(id) && !this.waiting.size) this.done();
  }

  /** The screen went away. */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private done() {
    if (this.lifted) return;
    this.lifted = true;
    this.dispose();
    this.lift();
  }
}
