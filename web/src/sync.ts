// Incremental lists: after the whole library (or trash) has loaded once, a live update asks the server only for what
// changed since (GET /api/items?since=<cursor>): new and changed records, the ids of those that left the list, and the
// next cursor. Only the changed records are decrypted. The whole list loads again when the server says "reset" (its
// cursor is too old, or the database was restored), and always against a server that hands out no cursor.

export interface Page { items: any[]; next?: string; cursor?: string; removed?: string[]; more?: boolean; reset?: boolean; [k: string]: unknown }

export interface ListSyncOptions<T extends { id: string }> {
  /** "/api/items" or "/api/trash" */
  path: string;
  get: (path: string) => Promise<Page>;
  /** decrypts records (and may keep what it decrypted before) */
  decrypt: (raw: any[]) => T[];
  order: (a: T, b: T) => number;
  /** the most pages one load follows: a server that never ends its list can't keep the app reading */
  maxPages?: number;
  /** sees every answer as it is applied (full: a whole list, which replaces everything), for a copy of the records */
  onPage?: (raw: any[], removed: string[], full: boolean) => void;
}

export interface Loaded<T> { items: T[]; extra: Record<string, unknown>; full: boolean }

/** Applies one page of changes: removed ids go, changed records replace theirs or are added. Pages apply in order, so
 *  an item changed on one page and purged on the next is gone. Returns the same array when nothing changed. */
export function applyChanges<T extends { id: string }>(list: T[], changed: T[], removed: Iterable<string>, order: (a: T, b: T) => number): T[] {
  const gone = new Set(removed);
  for (const it of changed) gone.delete(it.id);
  const fresh = new Map(changed.map((it) => [it.id, it]));
  if (!fresh.size && !list.some((it) => gone.has(it.id))) return list;
  const out: T[] = [];
  for (const it of list) {
    if (gone.has(it.id)) continue;
    const f = fresh.get(it.id);
    if (f) { out.push(f); fresh.delete(it.id); } else out.push(it);
  }
  // what is new to this device (also its own uploads, if the list didn't have them yet: by id, never twice)
  out.push(...fresh.values());
  return out.sort(order);
}

/** One list (the library or the trash), kept current with ?since. Loads run one after another: a load asked for
 *  while one runs waits for it and then asks the server again (the running one may have missed the change). */
export class ListSync<T extends { id: string }> {
  private list: T[] | null = null;
  private cursor: string | undefined;
  private gen = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private queued: Promise<Loaded<T>> | null = null;
  constructor(private o: ListSyncOptions<T>) {}

  /** The list as last loaded (null before the first load), and the cursor it is current to. */
  get current() { return this.list; }
  get at() { return this.cursor; }

  /** Starts from a list kept on the device and its cursor, if nothing was loaded yet: the first load then asks only
   *  for what changed since that copy was made. */
  seed(list: T[], cursor: string | undefined) { if (!this.list) { this.list = [...list].sort(this.o.order); this.cursor = cursor; } }

  /** Drops the list and its cursor (lock, sign-out): the next load is a whole one. */
  forget() { this.list = null; this.cursor = undefined; this.gen++; }

  /** Brings the list up to date: only the changes when it can, else the whole list. */
  load(): Promise<Loaded<T>> {
    if (this.queued) return this.queued;
    const p = this.tail.then(() => { this.queued = null; return this.step(); });
    this.queued = p;
    this.tail = p.catch(() => {});
    return p;
  }

  private async step(): Promise<Loaded<T>> {
    const gen = this.gen;
    if (this.list && this.cursor) {
      const r = await this.changes(this.cursor, gen);
      if (r) return r;
    }
    return this.whole(gen);
  }

  private async whole(gen: number): Promise<Loaded<T>> {
    const max = this.o.maxPages ?? 10_000;
    const first = await this.o.get(this.o.path);
    const raw = [...first.items];
    let next = first.next, pages = 1;
    while (next) {
      if (++pages > max) throw new Error("The server's list doesn't end.");
      const page = await this.o.get(`${this.o.path}?after=${encodeURIComponent(next)}`);
      raw.push(...page.items);
      next = page.next;
    }
    const items = this.o.decrypt(raw).sort(this.o.order);
    if (gen === this.gen) this.o.onPage?.(raw, [], true);
    // the first page's cursor: what changed while the later pages loaded comes with the next ?since
    if (gen === this.gen) { this.list = items; this.cursor = typeof first.cursor === "string" ? first.cursor : undefined; }
    return { items, extra: first, full: true };
  }

  /** null: the server wants the whole list again (reset) */
  private async changes(cursor: string, gen: number): Promise<Loaded<T> | null> {
    const max = this.o.maxPages ?? 10_000;
    let list = this.list!, cur = cursor, pages = 0;
    let last: Page;
    do {
      if (++pages > max) throw new Error("The server's list doesn't end.");
      last = await this.o.get(`${this.o.path}?since=${encodeURIComponent(cur)}`);
      if (last.reset) return null;
      if (typeof last.cursor !== "string" || !Array.isArray(last.removed)) return null; // not an answer to ?since
      list = applyChanges(list, last.items.length ? this.o.decrypt(last.items) : [], last.removed, this.o.order);
      if (gen === this.gen) this.o.onPage?.(last.items, last.removed, false);
      if (last.more && last.cursor === cur) throw new Error("The server's list doesn't end.");
      cur = last.cursor;
    } while (last.more);
    if (gen === this.gen) { this.list = list; this.cursor = cur; }
    return { items: list, extra: last, full: false };
  }
}
