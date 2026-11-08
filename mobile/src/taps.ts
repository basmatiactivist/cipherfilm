// Telling one tap from two on a photo in the viewer: two quick taps zoom, one tap shows or hides the bars. A single tap
// can only be known once no second one followed, so it waits that long first (as the gallery app does); a double tap
// acts at once and is never also taken as a single one.

export const DOUBLE_TAP_MS = 300;

export interface Taps<T> {
  /** one tap, with what the double-tap handler needs (where it was) */
  tap(at: T): void;
  /** forgets a tap still waiting: the page went away or was swiped */
  cancel(): void;
}

export function taps<T>(onSingle: () => void, onDouble: (at: T) => void, ms = DOUBLE_TAP_MS, now: () => number = Date.now): Taps<T> {
  let last = 0;
  let wait: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (wait !== undefined) { clearTimeout(wait); wait = undefined; } };
  return {
    tap(at) {
      const t = now();
      if (wait !== undefined && t - last <= ms) {
        cancel();
        last = 0;
        onDouble(at);
        return;
      }
      cancel();
      last = t;
      wait = setTimeout(() => { wait = undefined; onSingle(); }, ms);
    },
    cancel,
  };
}
