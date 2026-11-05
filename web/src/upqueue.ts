import { mem } from "./state";

/** What the queue needs of an upload: the account that chose the file, and whether the person cancelled it. */
export interface Queued { owner: string; stop: { cancelled: boolean } }

/**
 * Files waiting to upload, worked off a few at a time. The queue belongs to one account: files chosen by another are
 * refused, and once that account is no longer signed in (sign-out, someone else's sign-in in this tab) or the queue
 * is closed (the library left the screen), nothing more starts and whatever still waits is dropped.
 */
export function uploadQueue<J extends Queued>(owner: string, width: number, run: (j: J) => Promise<void>, idle: () => void) {
  let waiting: J[] = [];
  let workers = 0;
  let closed = false;
  const live = () => !closed && mem.me?.user.id === owner;
  return {
    push(list: J[]) {
      if (!live()) return;
      waiting.push(...list.filter((j) => j.owner === owner));
      while (workers < width && waiting.length) {
        workers++;
        (async () => {
          for (let j = waiting.shift(); j; j = waiting.shift()) {
            if (!live()) { waiting = []; break; }
            if (!j.stop.cancelled) await run(j);
          }
          workers--;
          if (workers === 0 && live()) idle();
        })();
      }
    },
    close() { closed = true; waiting = []; },
  };
}
