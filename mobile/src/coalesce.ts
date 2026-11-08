/** One run of f at a time: called again meanwhile, it runs once more after, however many calls came. A screen that
 *  reloads on every change of a running backup (several per file) otherwise piles up reloads that each query the
 *  phone's whole photo library, on the same thread as the backup's own work. */
export function coalesce(f: () => Promise<void>): () => Promise<void> {
  let going: Promise<void> | null = null;
  let again = false;
  return () => {
    if (going) { again = true; return going; }
    going = (async () => {
      try {
        do { again = false; await f(); } while (again);
      } finally {
        going = null;
      }
    })();
    return going;
  };
}
