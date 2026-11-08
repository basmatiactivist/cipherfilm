// Automatic backup: new photos and videos in the folders the person chose are encrypted on the phone and uploaded,
// in the background too. The background has no master key: each new item key is sealed to the account's public key
// (pinned here when backup was turned on, after checking it against the private key), so this code can add photos to
// the library but never read any. Android runs it through WorkManager (expo-background-task) about every 15 minutes
// when it allows; it also runs when the app opens, and on "Back up now". Once there is something to upload, a
// foreground service (N.keepRunning) keeps it going until it is done: off the screen, with the notification swiped
// away or the app swiped out of the recent apps. The Google Play build holds it only for "Back up now" (Play's rules
// for data transfers). Without it, a run stops after a few minutes and the next one goes on where it stopped.
import { Directory, File, Paths } from "expo-file-system";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { getSodium, b64, unb64 } from "@crypto/sodium";
import { accountKeyPair, sealItemKey } from "@crypto/item";
import { normEmail } from "@crypto/account";
import N from "../modules/cf-native/src/CfNativeModule";
import { api, ApiError, remote, type Remote } from "./api";
import { uploadFile, type Shared } from "./upload";
import { keepRunning, letGo } from "./keepAlive";
import { RunProgress, fmtSpeed, type LiveProgress } from "./backupProgress";
import { isPlayBuild } from "./store";
import { fingerprint } from "./prints";
import { indexUploaded, rememberUploaded, runBackgroundIndex } from "./search/background";
import { forgetSettings, loadSettings } from "./search/settings";
import { onSessionChange, onSignOut, savedServer } from "./session";

export const TASK = "cipherfilm-backup";

export interface Folder { name: string; after: number }
export interface Config {
  enabled: boolean;
  server: string; userId: string; email: string;
  /** the account's public key, checked against its private key when backup was turned on */
  pubkey: string;
  wifiOnly: boolean; chargingOnly: boolean;
  /** when a folder is added: also its photos already on the phone, or only new ones */
  includeExisting: boolean;
  /** chosen folders by Android's bucket id, each with the last MediaStore id done */
  folders: Record<string, Folder>;
}
export interface Status {
  running: boolean;
  lastRun?: number; lastDone?: number; uploaded: number;
  /** what keeps it from running right now, in plain words, and when that was */
  problem?: string;
  problemAt?: number;
  current?: string;
  /** the media ids a run was working on; still set at the next run means that run died on them (the app was killed or
   *  hung). One id (a string) from versions that went one file at a time. */
  attempt?: string[] | string;
  /** the file the last run stopped on that way, shown on the Backup screen until a run gets through */
  stalled?: string;
  skipped: { name: string; reason: string }[];
  failures: Record<string, number>;
  /** files too big for a run without the foreground service (the Google Play build's automatic runs): skipped there,
   *  uploaded by the next "Back up now" */
  needsYou?: { id: number; bucket: string; name: string }[];
  /** files uploaded and finalized but not yet confirmed by an account check (they are counted in batches): a run that
   *  dies before the check leaves them here, and the next one confirms them instead of uploading them again */
  unconfirmed?: { userId: string; print: string }[];
}

const DIR = () => new Directory(Paths.document, "backup");
const CONFIG = () => new File(DIR(), "config.json");
const STATUS = () => new File(DIR(), "status.json");
const KNOWN = () => new File(DIR(), "known.json");

async function readJson<T>(f: File, fallback: T): Promise<T> {
  try {
    if (!f.exists) return fallback;
    const v = JSON.parse(await f.text());
    // objects get the defaults for fields added later; lists come back as they are
    return fallback && typeof fallback === "object" && !Array.isArray(fallback) ? { ...fallback, ...v } : v;
  } catch {
    return fallback;
  }
}
async function writeJson(f: File, v: unknown) {
  DIR().create({ intermediates: true, idempotent: true });
  await f.write(JSON.stringify(v));
}

export const loadConfig = () => readJson<Config | null>(CONFIG(), null);
// "running" from this process: a run that Android ended mid-way left true in the file
export const loadStatus = async () => ({ ...(await readJson<Status>(STATUS(), { running: false, uploaded: 0, skipped: [], failures: {} })), running });
export const saveConfig = (c: Config) => writeJson(CONFIG(), c);

// ---- what changes the screen listens to ----
const subs = new Set<() => void>();
export const onBackupChange = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const changed = () => subs.forEach((f) => f());

// ---- how far the run going on now is (for the Backup screen: only in memory, never written) ----
let live: LiveProgress | null = null;
const progressSubs = new Set<() => void>();
/** While a run uploads: n of m, what is left and how fast; null otherwise. */
export const backupProgress = () => live;
export const onBackupProgress = (f: () => void) => { progressSubs.add(f); return () => { progressSubs.delete(f); }; };
const setLive = (p: LiveProgress | null) => { live = p; progressSubs.forEach((f) => f()); };

// ---- turning it on and off (only while the library is unlocked) ----

/** Checks the account's public key against its private key and pins it, then schedules the background task. */
/** The server refuses every upload of the public demo login: a backup would only try again and again. */
export const DEMO_BACKUP = "This is the public demo: it can't store photos, so backup stays off.";

export async function enableBackup(me: { user: { id: string; email: string }; pubkey: string; wrapped_privkey: string; demo?: boolean }, server: string, master: Uint8Array, choice: Omit<Config, "enabled" | "server" | "userId" | "email" | "pubkey">) {
  if (me.demo) throw new Error(DEMO_BACKUP);
  const s = await getSodium();
  const pair = accountKeyPair(s, unb64(s, me.wrapped_privkey), master, normEmail(me.user.email));
  s.memzero(pair.sk);
  if (!s.memcmp(pair.pk, unb64(s, me.pubkey))) throw new Error("Your account's keys don't match. Backup was not turned on.");
  await saveConfig({ ...choice, enabled: true, server, userId: me.user.id, email: me.user.email, pubkey: b64(s, pair.pk) });
  await scheduleBackground();
  changed();
}

export async function disableBackup() {
  const c = await loadConfig();
  if (c) await saveConfig({ ...c, enabled: false });
  await scheduleBackground();
  N.backupNotifyCancel();
  changed();
}

/** A folder's starting point: everything in it, or only what comes after its newest photo now. */
export const startAfter = (includeExisting: boolean, newest: number) => (includeExisting ? 0 : newest);

/**
 * The folders after a change on the Backup screen. "Photos and videos already on this phone" applies to every chosen folder, not
 * only to ones ticked later: switching to "also the ones already there" starts each folder from its beginning again
 * (what the library has is skipped by name and size), switching to "only new" moves each past its newest photo now.
 * Folders that stay and keep the setting keep their place.
 */
export function chooseFolders(cur: Config, ids: Iterable<string>, includeExisting: boolean, phone: { id: string; name: string; newest: number }[]): Config["folders"] {
  const byId = new Map(phone.map((f) => [f.id, f]));
  const switched = includeExisting !== cur.includeExisting;
  const out: Config["folders"] = {};
  for (const id of ids) {
    const was = cur.folders[id];
    const newest = byId.get(id)?.newest ?? 0;
    const name = was?.name ?? byId.get(id)?.name ?? "Folder";
    out[id] = was && !switched ? was : { name, after: was && !includeExisting ? Math.max(was.after, newest) : startAfter(includeExisting, newest) };
  }
  return out;
}

// ---- duplicates: what the library already has (name and size), refreshed while it is unlocked ----


/** Called with the decrypted library: photos that are already there (shared in, or uploaded from a computer) are skipped.
 *  Only the library of the account the backup is for counts: another account's photos are no reason to skip one. */
export async function rememberLibrary(userId: string, items: { meta?: { name: string; size: number } }[]) {
  const c = await loadConfig();
  if (!c?.enabled || c.userId !== userId) return;
  const prints = await Promise.all(items.filter((i) => i.meta).map((i) => fingerprint(i.meta!.name, i.meta!.size)));
  await writeJson(KNOWN(), { userId, prints });
}

// ---- the run ----


let running = false;
let generation = 0; // bumped at sign-out and whenever the session changes hands: a run still going stops and keeps nothing
const OTHER_ACCOUNT = "another account";
const HALTED = "halted";
const ANOTHER = "Signed in with another account. Backup continues when this account signs in again.";
const BACKGROUND_BUDGET = 8 * 60_000; // WorkManager stops work after 10 minutes, if the service couldn't start
const MAX_TRIES = 3;
// files at once, like the web app; at most 3 × 2 parts of 4 MiB in memory (upload.ts SEGMENTS_IN_FLIGHT)
const FILES_IN_FLIGHT = 3;
// the account check that counts finished files: after this many, or this long after the last one, and at the end
const CHECK_FILES = 6;
const CHECK_EVERY = 30_000;
const EMPTY = "The file is empty (0 bytes).";

/** Whether a run may start now, and if not, why (in plain words). Manual runs ignore Wi-Fi and charging. */
export function blocker(c: Config, manual: boolean): string | undefined {
  const st = N.backupState();
  if (st.media === "none") return "Cipherfilm can't see your photos. Allow access in Backup.";
  if (!st.online) return "Waiting for an internet connection.";
  if (!manual && c.wifiOnly && !st.unmetered) return "Waiting for Wi-Fi.";
  if (!manual && c.chargingOnly && !st.charging) return "Waiting for the phone to charge.";
  return undefined;
}

/** /api/me, tried three times over half a minute: a phone that just woke up or changed networks often needs a moment. */
async function reach(to: Remote): Promise<{ user: { id: string }; csrf: string }> {
  for (let i = 0; ; i++) {
    try {
      return await api("GET", "/api/me", undefined, to);
    } catch (e) {
      if (i >= 2 || !(e instanceof ApiError) || !(e.status === 0 || e.status >= 500)) throw e;
      await new Promise((r) => setTimeout(r, i ? 20_000 : 5_000));
    }
  }
}

export async function runBackup(trigger: "background" | "app" | "manual"): Promise<void> {
  if (running) return;
  running = true; // before the first await: the app calls this on start and on becoming active, at once
  const gen = generation;
  const current = () => gen === generation;
  const c = await loadConfig();
  if (!c?.enabled) { running = false; return; }
  const status = await loadStatus();
  const save = async () => { if (current()) { await writeJson(STATUS(), status); changed(); } };
  /** "stop" when backup was turned off or now belongs to another account; "gone" when the folder is no longer chosen. */
  const still = (now: Config | null, bucket: string): "ok" | "gone" | "stop" =>
    !current() || !now?.enabled || now.userId !== c.userId || now.server !== c.server ? "stop" : now.folders[bucket] ? "ok" : "gone";
  /** Moves a folder's place past a finished file in the saved settings, read fresh: what the person changed while this
   *  run went on (backup turned off, folders, "also the ones already there") stays. */
  const advance = async (bucket: string, from: number, to: number): Promise<"ok" | "gone" | "stop"> => {
    if (!current()) return "stop";
    const now = await loadConfig();
    const r = still(now, bucket);
    if (r !== "ok") return r;
    const f = now!.folders[bucket];
    if (f.after !== from) return "ok"; // the person moved it meanwhile (e.g. to the folder's beginning): theirs counts
    f.after = to;
    // not saved (storage trouble): the next run looks at the file again, and skips it as known
    await saveConfig(now!).catch(() => {});
    return "ok";
  };
  let deadline = trigger === "background" ? Date.now() + BACKGROUND_BUDGET : Infinity;
  let held = false, holding = false;
  if (status.attempt && status.current) status.stalled = status.current; // the last run died on this one
  status.running = true; status.lastRun = Date.now(); status.problem = undefined; status.problemAt = undefined; status.current = undefined;
  await save();
  let done = 0, gaveUp = 0;
  try {
    const why = blocker(c, trigger === "manual");
    if (why) { status.problem = why; return; }
    // "Back up now" (it may run until done): the big files the automatic runs left go first, by moving each folder's
    // place back to before them; what is already in the library on the way is skipped as known
    if (trigger === "manual" && status.needsYou?.length) {
      for (const w of status.needsYou) { const f = c.folders[w.bucket]; if (f && f.after >= w.id) f.after = w.id - 1; }
      await saveConfig(c).catch(() => {});
      status.needsYou = undefined;
      await save();
    }

    // nothing new on the phone: no request at all (a run every 15 minutes), and a server that is down then is no problem
    let waiting = 0;
    for (const [bucket, f] of Object.entries(c.folders)) waiting += await N.countFolderAfter(bucket, f.after);
    if (!waiting) { if (!status.needsYou?.length) status.lastDone = Date.now(); return; } // all done: say so, as of now
    if (c.server !== (await savedServer())) { status.problem = "Cipherfilm now uses another server. Turn backup on again."; await disableBackup(); return; }
    // the run's own server and token: the app's are left alone
    const to = remote(c.server);
    let me: { user: { id: string }; csrf: string };
    try {
      me = await reach(to);
    } catch (e) {
      if (e instanceof ApiError) console.log(`backup: server not reached (${e.status}) ${e.detail}`);
      status.problem = e instanceof ApiError && e.status === 401 ? "You were signed out. Sign in to continue the backup." : "Can't connect to the server. Trying again in a few minutes.";
      if (e instanceof ApiError && e.status === 401) N.backupNotify("Backup paused", "Sign in to Cipherfilm to continue.", 0, false);
      return;
    }
    if (me.user.id !== c.userId) { status.problem = "Signed in with another account. Turn backup on again for this one."; await disableBackup(); return; }
    to.csrf = me.csrf;
    // the session may change hands while the run goes on: uploads go only to c.userId
    const stillMine = async () => {
      const who = await api<{ user: { id: string }; csrf: string }>("GET", "/api/me", undefined, to);
      if (who.user.id !== c.userId || !current()) throw new Error(OTHER_ACCOUNT);
      to.csrf = who.csrf;
    };

    const s = await getSodium();
    const pk = unb64(s, c.pubkey);
    const kept = await readJson<{ userId?: string; prints?: string[] }>(KNOWN(), {});
    const known = new Set(kept.userId === c.userId && Array.isArray(kept.prints) ? kept.prints : []);
    // uploaded by a run that died before its account check: confirmed now (this session still belongs to c.userId,
    // checked above), so they are skipped as known instead of uploaded twice
    const left = (status.unconfirmed ?? []).filter((u) => u.userId === c.userId && typeof u.print === "string");
    if (status.unconfirmed?.length) {
      left.forEach((u) => known.add(u.print));
      status.unconfirmed = undefined;
      if (left.length) await writeJson(KNOWN(), { userId: c.userId, prints: [...known] });
      await save();
    }
    const total = waiting;
    // The foreground service keeps a run going off screen. Google Play allows it (dataSync, "backup and restore") only for
    // a transfer the person started: there only "Back up now" holds it, and automatic runs work in WorkManager's time
    // and go on in the next run. The GitHub build keeps it for every run.
    if (!isPlayBuild() || trigger === "manual") {
      holding = true;
      held = keepRunning("backup", "Backing up", total === 1 ? "1 photo or video" : `${total} photos and videos`);
    }
    if (held) deadline = Infinity;
    const outOfTime = () => Date.now() > deadline || (held && N.keepRunningLost()) || !current();
    // the one progress notification (the foreground service's), updated in place: n of m over the whole run (never
    // going back while files finish out of order), the oldest file under way, how fast, how far overall
    const progress = new RunProgress(total);
    let shownAt = 0, shown = "";
    const show = (force = false, note?: string) => {
      const now = Date.now();
      if (!force && now - shownAt < 1000) return; // Android drops updates that come faster
      const p = progress.get();
      if (current()) setLive(p);
      const name = going.values().next().value;
      if (!name) return; // between files: the next one shows itself
      const title = `Backing up ${p.position} of ${p.total}`;
      const text = note ?? (p.speed ? `${name} · ${fmtSpeed(p.speed)}` : name);
      const same = `${title}\n${text}\n${Math.round(p.fraction * 100)}`;
      if (same === shown) return; // nothing new: no update for Android to drop
      shownAt = now; shown = same;
      N.backupNotify(title, text, p.fraction, true);
    };

    // Several files at once: a small photo mostly waits on round trips, not on the connection. A run stops taking new
    // files once it halts (out of time, a problem, backup turned off); the ones under way finish.
    let halt = false;
    let abandon = false; // the session changed hands: the files under way stop too
    const stop = (problem?: string) => { halt = true; if (problem) status.problem ??= problem; };
    const serverProblem = (e: ApiError) => (e.status === 413 ? "Your storage on the server is full." : e.status === 401 ? "You were signed out. Sign in to continue the backup." : "Can't connect to the server. Trying again in a few minutes.");
    // the files under way, oldest first: status.attempt (a run that dies counts a try for each) and status.current
    const going = new Map<string, string>();
    const sync = () => {
      status.attempt = going.size ? [...going.keys()] : undefined;
      status.current = going.values().next().value;
    };
    const attempts = () => (typeof status.attempt === "string" ? [status.attempt] : status.attempt ?? []); // one id from versions that went one file at a time
    const died = new Set(attempts());

    // Each folder's place moves past a file only once it and every file before it are done with, so a run that stops or
    // dies never skips one. One move at a time: each reads and writes the saved settings.
    let moving = Promise.resolve();
    const mover = (bucket: string, folder: Folder) => {
      const order: { id: number; done: boolean }[] = []; // the folder's files this run took, in order
      let gone = false; // the folder is no longer chosen
      return {
        gone: () => gone,
        take: (id: number) => { order.push({ id, done: false }); },
        /** Done with a file (uploaded, already in the library, or given up on). True once the folder's place is past it. */
        past: (id: number): Promise<boolean> => {
          order.find((o) => o.id === id)!.done = true;
          waiting--;
          return (moving = moving.then(async () => {
            let to = folder.after;
            while (order[0]?.done) to = order.shift()!.id;
            if (to !== folder.after) {
              const r = await advance(bucket, folder.after, to);
              folder.after = to;
              if (r === "stop") stop();
              if (r === "gone") gone = true;
            }
          })).then(() => folder.after >= id);
        },
      };
    };

    // Finished files are counted at the next account check, not each after its own: one /api/me for several files,
    // sent after they were finalized. What a check finds in another account's hands is never counted.
    const unconfirmed: { m: { id: number; uri: string; mime: string }; print: string; id: string; past: (id: number) => Promise<boolean> }[] = [];
    const toIndex: { print: string; id: string; uri: string; video: boolean }[] = []; // for search, after the uploads
    let checkedAt = Date.now();
    let checking = Promise.resolve();
    let pausing = 0; // files waiting for the server: what is done meanwhile counts at once, a run may end in the wait
    /** "due": every CHECK_FILES files or CHECK_EVERY, or while a file waits for the server; "now": at the end. While a
     *  file waits for the server, a check that gets no answer is no problem yet. */
    const settle = (when: "due" | "now") => (checking = checking.then(async () => {
      if (!unconfirmed.length || (when === "due" && !pausing && unconfirmed.length < CHECK_FILES && Date.now() - checkedAt < CHECK_EVERY)) return;
      const soft = when === "due" && pausing > 0;
      const ready = unconfirmed.splice(0);
      try {
        await stillMine();
      } catch (e) {
        if (e instanceof Error && e.message === OTHER_ACCOUNT) {
          // they went to whoever holds the session now, not to c.userId: not backed up, so not noted as such
          const gone = new Set(ready.map((u) => u.print));
          status.unconfirmed = status.unconfirmed?.filter((u) => !gone.has(u.print));
          abandon = true; stop(ANOTHER); return;
        }
        unconfirmed.unshift(...ready); // counted at a later check, or uploaded again by the next run
        if (!soft) stop(e instanceof ApiError ? serverProblem(e) : e instanceof Error ? e.message : String(e));
        return;
      }
      checkedAt = Date.now();
      const settled = new Set(ready.map((u) => u.print));
      status.unconfirmed = status.unconfirmed?.filter((u) => !settled.has(u.print));
      if (!status.unconfirmed?.length) status.unconfirmed = undefined;
      let behind = false;
      for (const u of ready) {
        // for search: never inside the upload service (a data transfer, Google Play's foreground service rules), then
        // the next background run indexes it; otherwise once the uploads are done (below), not here: the model and
        // a third decode of the photo would hold up the uploads under way
        if (held) await rememberUploaded(c.userId, u.print, u.id);
        else toIndex.push({ print: u.print, id: u.id, uri: u.m.uri, video: (u.m.mime ?? "").startsWith("video/") });
        known.add(u.print);
        delete status.failures[String(u.m.id)];
        status.uploaded++; done++;
        if (!(await u.past(u.m.id))) behind = true;
      }
      // counted but behind a file still under way: a run that dies now skips it next time as known, not uploads it again
      if (behind && current()) await writeJson(KNOWN(), { userId: c.userId, prints: [...known] });
      await save();
    }).catch((e) => { stop(e instanceof Error ? e.message : String(e)); }));

    const upload = async (m: { id: number; uri: string; name: string; size: number; mime: string }, print: string, bucket: string, past: (id: number) => Promise<boolean>) => {
      const key = String(m.id);
      going.set(key, m.name); sync();
      progress.start(key);
      show(true);
      await save();
      let sent = 0; // of this file, for the speed
      const file: Shared = { uri: m.uri, name: m.name, size: m.size, mime: m.mime || "application/octet-stream", deletable: false };
      try {
        let id = "";
        // the server out of reach mid-file: wait and try the file again twice before the run gives up
        for (let attempt = 0; ; attempt++) {
          try {
            if (attempt) await stillMine(); // after each wait
            id = await uploadFile(file, s, (itemKey, id) => sealItemKey(s, itemKey, pk, id), () => {
              if (abandon) throw new Error(OTHER_ACCOUNT);
              if (Date.now() > deadline + 90_000 || (held && N.keepRunningLost()) || !current()) throw new Error("out of time"); // finish next time
            }, (d, t) => { progress.sent(key, t ? d / t : 0, d - sent); sent = d; show(); }, to);
            break;
          } catch (e) {
            if (attempt >= 2 || !(e instanceof ApiError) || !(e.status === 0 || e.status >= 500) || outOfTime()) throw e;
            if (halt) throw new Error(HALTED); // the run stops for another reason: no wait, and not this file's failure
            console.log(`backup: upload failed (${e.status}) ${e.detail}; trying again`); // ids only, no names
            show(true, `${m.name} · waiting for the server…`);
            pausing++;
            settle("due"); // what is done so far counts before the wait
            await new Promise((r) => setTimeout(r, attempt ? 90_000 : 30_000)).finally(() => { pausing--; });
          }
        }
        going.delete(key); sync();
        progress.finish(key); show(true); // done uploading (counted as backed up only after the check below)
        // counted as backed up only once it is certain the file went to c.userId; noted at once, so a run that dies
        // before that check doesn't upload it again
        unconfirmed.push({ m, print, id, past });
        status.unconfirmed = [...(status.unconfirmed ?? []), { userId: c.userId, print }];
        await save();
        settle("due");
      } catch (e) {
        going.delete(key); sync(); // a failure seen here is counted below
        progress.drop(key);
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof ApiError) console.log(`backup: upload failed (${e.status}) ${e.detail}`); // ids only, no names
        if (msg === "out of time" && !held && trigger !== "manual" && isPlayBuild()) {
          // too big to finish here, and it would start over every run: it waits for "Back up now", the photos
          // after it go on in the next run
          status.needsYou = [...(status.needsYou ?? []).filter((w) => w.id !== m.id), { id: m.id, bucket, name: m.name }];
          progress.finish();
          await past(m.id);
          stop();
        } else if (msg === "out of time" || msg === HALTED) stop();
        else if (msg === OTHER_ACCOUNT) { abandon = true; stop(ANOTHER); }
        else {
          const tries = (status.failures[key] ?? 0) + 1;
          status.failures[key] = tries;
          if (e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 401 || e.status === 413)) stop(serverProblem(e));
          else if (tries >= MAX_TRIES) { // this file can't be read or uploaded: leave it and go on
            status.skipped = [{ name: m.name, reason: msg }, ...status.skipped].slice(0, 50);
            delete status.failures[key];
            gaveUp++;
            progress.finish();
            await past(m.id);
          } else stop(`${m.name}: ${msg}`);
        }
      }
      await save();
    };

    const inflight = new Set<Promise<void>>();
    // the speed also when no part finishes for a while (a large file on a slow link, a stall): it goes down then
    const ticker = setInterval(() => show(), 2_000);
    try {
      outer: for (const [bucket, folder] of Object.entries(c.folders)) {
        const { gone, take, past } = mover(bucket, folder);
        let next = folder.after;
        for (;;) {
          const batch = await N.folderMedia(bucket, next, 25);
          if (!batch.length) break;
          for (const m of batch) {
            if (halt || outOfTime()) break outer;
            // turned off, or the folder no longer chosen, while files were under way: no more from here
            const r = still(await loadConfig(), bucket);
            if (r === "stop") break outer;
            if (gone() || r === "gone") continue outer;
            take(m.id); next = m.id;
            progress.take();
            const print = await fingerprint(m.name, m.size);
            if (known.has(print)) { progress.finish(); await past(m.id); continue; }
            if (!m.size) { // nothing to back up (an app left an empty file): named under Backup, not an empty photo in the library
              status.skipped = [{ name: m.name, reason: EMPTY }, ...status.skipped].slice(0, 50);
              gaveUp++;
              progress.finish();
              await past(m.id);
              await save();
              continue;
            }
            const key = String(m.id);
            const suspect = died.delete(key);
            if (suspect) { // the last run never got past this file: count that as a failed try
              const tries = (status.failures[key] ?? 0) + 1;
              status.failures[key] = tries;
              const left = attempts().filter((a) => a !== key);
              status.attempt = left.length ? left : undefined;
              if (tries >= MAX_TRIES) {
                status.skipped = [{ name: m.name, reason: "Cipherfilm stopped while reading this file" }, ...status.skipped].slice(0, 50);
                delete status.failures[key];
                gaveUp++;
                progress.finish();
                await past(m.id);
                await save();
                continue;
              }
              // alone: should the run die on it again, the files beside it don't get a try counted for it
              await Promise.all(inflight);
              if (halt) break outer;
            }
            const work: Promise<void> = upload(m, print, bucket, past).finally(() => { inflight.delete(work); });
            inflight.add(work);
            if (suspect) await work;
            else if (inflight.size >= FILES_IN_FLIGHT) await Promise.race(inflight);
          }
        }
      }
    } finally {
      await Promise.all(inflight);
      clearInterval(ticker);
    }
    if (!abandon) settle("now");
    await checking;
    await moving;
    if (current()) await writeJson(KNOWN(), { userId: c.userId, prints: [...known] });
    if (!status.problem && waiting <= 0) status.lastDone = Date.now();
    // for search, now that the uploads are done: while the run still has time, the rest by the next background run
    // (the session checked once more if the last check is a while ago: it may have changed hands since)
    setLive(null);
    const sameAccount = toIndex.length && !abandon && (Date.now() - checkedAt < CHECK_EVERY || await stillMine().then(() => true, () => false));
    for (const u of toIndex) {
      if (!current() || abandon) break;
      if (sameAccount && Date.now() < deadline) await indexUploaded(s, u.id, u.uri, u.video, pk, to);
      else await rememberUploaded(c.userId, u.print, u.id);
    }
  } catch (e) {
    status.problem = e instanceof Error ? e.message : String(e);
  } finally {
    if (status.problem) status.problemAt = Date.now();
    // couldn't reach the server: try again in a few minutes, not only at the next periodic run
    if (status.problem && /reach|connect/i.test(status.problem) && current()) N.retryBackupSoon(3);
    console.log(`backup (${trigger}): ${done} uploaded${status.problem ? `, stopped: ${status.problem}` : ""}`); // no names, no keys
    status.running = false; status.current = undefined;
    setLive(null);
    if (!status.attempt) status.stalled = undefined; // got past it (a run that dies never gets here)
    await save();
    running = false;
    if (holding) letGo("backup");
    N.backupNotifyCancel();
    const summary = backupSummary(done, gaveUp, status.problem);
    if (summary && current()) N.backupNotify(summary.title, summary.text, 0, false);
    const big = status.needsYou?.length ?? 0;
    if (big && current() && trigger !== "manual") {
      N.backupNotify(big === 1 ? "A large video is waiting" : `${big} large videos are waiting`, "Open Cipherfilm › Backup and tap Back up now to upload it.", 0, false);
    }
  }
}

/** The one notification after a run: what was backed up, what couldn't be, and why it stopped (if it did). Nothing when
 *  nothing happened, so a run every 15 minutes that waits for Wi-Fi doesn't notify each time. */
export function backupSummary(done: number, gaveUp: number, problem?: string): { title: string; text: string } | null {
  if (!done && !gaveUp) return null;
  const parts = [done === 1 ? "1 photo or video backed up." : done ? `${done} photos and videos backed up.` : ""];
  if (gaveUp) parts.push(gaveUp === 1 ? "1 couldn't be backed up." : `${gaveUp} couldn't be backed up.`);
  if (problem) parts.push(`Stopped: ${problem}`);
  return { title: gaveUp || problem ? "Backup incomplete" : "Backup done", text: parts.filter(Boolean).join(" ") };
}

export const backupRunning = () => running;

/**
 * Photos and videos in the chosen folders from before the backup's place there ("only new ones" when the folder was
 * chosen) that the library doesn't have (by name and size): they are not backed up, and the Backup screen says so
 * instead of "Everything is backed up".
 */
export async function notBackedUp(): Promise<number> {
  const c = await loadConfig();
  if (!c?.enabled) return 0;
  const kept = await readJson<{ userId?: string; prints?: string[] }>(KNOWN(), {});
  const known = new Set(kept.userId === c.userId && Array.isArray(kept.prints) ? kept.prints : []);
  let n = 0;
  for (const [bucket, f] of Object.entries(c.folders)) {
    let after = 0;
    while (after < f.after) {
      const batch = await N.folderMedia(bucket, after, 500).catch(() => []);
      if (!batch.length) break;
      for (const m of batch) {
        if (m.id > f.after) { after = f.after; break; }
        after = m.id;
        if (!known.has(await fingerprint(m.name, m.size))) n++;
      }
    }
  }
  return n;
}

/** How many photos and videos wait in the chosen folders, the big ones left for "Back up now" included. */
export async function waitingCount(): Promise<number> {
  const c = await loadConfig();
  if (!c?.enabled) return 0;
  let n = (await loadStatus()).needsYou?.length ?? 0;
  for (const [bucket, f] of Object.entries(c.folders)) n += await N.countFolderAfter(bucket, f.after).catch(() => 0);
  return n;
}

/** The one background task runs the backup and background search indexing; it stays scheduled while either is on. */
export async function scheduleBackground() {
  const [c, st] = await Promise.all([loadConfig(), loadSettings()]);
  const want = !!c?.enabled || (st.enabled && st.background);
  try {
    if (want) await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
    else await BackgroundTask.unregisterTaskAsync(TASK);
  } catch { /* already in that state */ }
  N.watchNewMedia(want); // and seconds after a new photo or video
}

// A session end, another sign-in or another server: a run still going stops before its next request.
onSessionChange(() => { generation++; });

// Sign-out: nothing of the account stays on the phone (the search models do; they hold nothing of anyone).
onSignOut(async () => {
  generation++;
  try { const d = DIR(); if (d.exists) d.delete(); } catch { /* best effort */ }
  forgetSettings();
  await scheduleBackground();
  N.backupNotifyCancel();
  N.clearCookies();
  changed();
});

// The background entry: defined when the bundle loads (index.js), also when Android starts the app only for this.
TaskManager.defineTask(TASK, async () => {
  try {
    await runBackup("background");
    // a backup still going from an earlier run (in the service) uses the models itself
    if (!running) await runBackgroundIndex();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});
