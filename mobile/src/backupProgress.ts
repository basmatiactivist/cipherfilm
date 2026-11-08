// How far a backup run is, for its progress notification and the Backup screen. Several files upload at once
// (backup.ts FILES_IN_FLIGHT), so "n of m" can't be the number of whichever file reported last: that went 23, 21,
// 22, 23 as the files under way took turns. Here it only counts what the run is done with, so it never goes back.
import { locale } from "./i18n";

/** The speed is what went out over the last few seconds: a smooth number, still quick to show a stall. */
export const SPEED_WINDOW = 8_000;
/** Before that much time with data going out, there is no speed worth showing yet. */
const SPEED_MIN = 2_000;

export interface LiveProgress {
  /** the file the run is at: files done with, plus the one under way; never smaller than before */
  position: number;
  total: number;
  /** files this run hasn't finished yet */
  left: number;
  /** 0..1, never smaller than before */
  fraction: number;
  /** bytes per second over the last few seconds, or undefined when it can't be told yet */
  speed?: number;
}

export class RunProgress {
  private done = 0;
  private taken = 0;
  private under = new Map<string, number>(); // files under way: how much of each is sent, 0..1
  private samples: { at: number; bytes: number }[] = [];
  private since?: number; // when the first file started
  private shown = { position: 0, fraction: 0 };

  constructor(private total: number, private now: () => number = Date.now) {}

  /** The run took the next file (to upload or to skip). New photos found during the run make the total grow. */
  take() { this.taken++; if (this.taken > this.total) this.total = this.taken; }
  /** A file starts uploading. */
  start(key: string) { this.under.set(key, 0); this.since ??= this.now(); }
  /** More of a file went out: fraction of the file now, and the bytes since the last call. */
  sent(key: string, fraction: number, bytes: number) {
    if (this.under.has(key)) this.under.set(key, Math.max(0, Math.min(1, fraction)));
    if (bytes > 0) {
      const at = this.now();
      this.samples.push({ at, bytes });
      while (this.samples.length && this.samples[0].at < at - SPEED_WINDOW) this.samples.shift();
    }
  }
  /** Done with a file: uploaded, already in the library, or given up on. */
  finish(key?: string) { if (key) this.under.delete(key); this.done++; }
  /** A file stops without being done (the run stops; the next run takes it again). */
  drop(key: string) { this.under.delete(key); }

  speed(): number | undefined {
    if (this.since === undefined) return undefined;
    const at = this.now();
    const span = Math.min(SPEED_WINDOW, at - this.since);
    if (span < SPEED_MIN) return undefined;
    let bytes = 0;
    for (const s of this.samples) if (s.at >= at - SPEED_WINDOW) bytes += s.bytes;
    return (bytes * 1000) / span;
  }

  get(): LiveProgress {
    const total = Math.max(this.total, 1);
    // the file under way counts as "at", files that finish out of order never pull the number back
    const position = Math.min(total, Math.max(this.shown.position, this.done + (this.under.size ? 1 : 0)));
    let partial = 0;
    for (const f of this.under.values()) partial += f;
    const fraction = Math.min(1, Math.max(this.shown.fraction, (this.done + partial) / total));
    this.shown = { position, fraction };
    return { position, total: this.total, left: Math.max(0, this.total - this.done), fraction, speed: this.speed() };
  }
}

/** "2.4 MB/s", "850 KB/s" (German "2,4 MB/s"; like upload.ts fmtSize; not imported, so this file needs nothing of the phone). */
export const fmtSpeed = (b: number) => (b >= 1e6 ? `${(b / 1e6).toLocaleString(locale(), ONE_DIGIT)} MB/s` : `${Math.max(1, Math.round(b / 1e3)).toLocaleString(locale())} KB/s`);
const ONE_DIGIT = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
