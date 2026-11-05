// Automatic backup: new photos and videos in the folders the person chose are encrypted on the phone and uploaded,
// in the background too. The background has no master key: each new item key is sealed to the account's public key
// (pinned here when backup was turned on, after checking it against the private key), so this code can add photos to
// the library but never read any. Android runs it through WorkManager (expo-background-task) about every 15 minutes
// when it allows; it also runs when the app opens, and on "Back up now". Once there is something to upload, a
// foreground service (N.keepRunning) keeps it going until it is done: off the screen, with the notification swiped
// away or the app swiped out of the recent apps. Where Android doesn't allow that, a run stops after a few minutes and
// the next one goes on where it stopped.
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
import { fingerprint } from "./prints";
import { indexUploaded, runBackgroundIndex } from "./search/background";
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
  skipped: { name: string; reason: string }[];
  failures: Record<string, number>;
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

// ---- turning it on and off (only while the library is unlocked) ----

/** Checks the account's public key against its private key and pins it, then schedules the background task. */
export async function enableBackup(me: { user: { id: string; email: string }; pubkey: string; wrapped_privkey: string }, server: string, master: Uint8Array, choice: Omit<Config, "enabled" | "server" | "userId" | "email" | "pubkey">) {
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

// ---- duplicates: what the library already has (name and size), refreshed while it is unlocked ----


/** Called with the decrypted library: photos that are already there (shared in, or uploaded from a computer) are skipped. */
export async function rememberLibrary(items: { meta?: { name: string; size: number } }[]) {
  const c = await loadConfig();
  if (!c?.enabled) return;
  const prints = await Promise.all(items.filter((i) => i.meta).map((i) => fingerprint(i.meta!.name, i.meta!.size)));
  await writeJson(KNOWN(), prints);
}

// ---- the run ----


let running = false;
let generation = 0; // bumped at sign-out and whenever the session changes hands: a run still going stops and keeps nothing
const OTHER_ACCOUNT = "another account";
const BACKGROUND_BUDGET = 8 * 60_000; // WorkManager stops work after 10 minutes, if the service couldn't start
const MAX_TRIES = 3;

/** Whether a run may start now, and if not, why (in plain words). Manual runs ignore Wi-Fi and charging. */
export function blocker(c: Config, manual: boolean): string | undefined {
  const st = N.backupState();
  if (st.media === "none") return "Cipherfilm isn't allowed to see your photos. Allow it under Backup.";
  if (!st.online) return "Waiting for an internet connection.";
  if (!manual && c.wifiOnly && !st.unmetered) return "Waiting for Wi-Fi.";
  if (!manual && c.chargingOnly && !st.charging) return "Waiting until the phone is charging.";
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
  const keep = async () => { if (current()) await saveConfig(c); };
  let deadline = trigger === "background" ? Date.now() + BACKGROUND_BUDGET : Infinity;
  let held = false, holding = false;
  status.running = true; status.lastRun = Date.now(); status.problem = undefined; status.problemAt = undefined; status.current = undefined;
  await save();
  let done = 0;
  try {
    const why = blocker(c, trigger === "manual");
    if (why) { status.problem = why; return; }

    if (c.server !== (await savedServer())) { status.problem = "Cipherfilm now uses another server. Turn backup on again."; await disableBackup(); return; }
    // the run's own server and token: the app's are left alone
    const to = remote(c.server);
    let me: { user: { id: string }; csrf: string };
    try {
      me = await reach(to);
    } catch (e) {
      if (e instanceof ApiError) console.log(`backup: server not reached (${e.status}) ${e.detail}`);
      status.problem = e instanceof ApiError && e.status === 401 ? "You were signed out. Open Cipherfilm and sign in to continue the backup." : "Can't connect to the server. The backup tries again in a few minutes.";
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
    const kept = await readJson<string[]>(KNOWN(), []);
    const known = new Set(Array.isArray(kept) ? kept : []);
    let waiting = 0;
    for (const [bucket, f] of Object.entries(c.folders)) waiting += await N.countFolderAfter(bucket, f.after);
    if (!waiting) return;
    holding = true;
    held = keepRunning("backup", "Backing up", `${waiting} waiting`);
    if (held) deadline = Infinity;
    const outOfTime = () => Date.now() > deadline || (held && N.keepRunningLost()) || !current();

    outer: for (const [bucket, folder] of Object.entries(c.folders)) {
      for (;;) {
        const batch = await N.folderMedia(bucket, folder.after, 25);
        if (!batch.length) break;
        for (const m of batch) {
          if (outOfTime()) break outer;
          const print = await fingerprint(m.name, m.size);
          if (known.has(print)) { folder.after = m.id; await keep(); waiting--; continue; }
          status.current = m.name;
          N.backupNotify("Backing up", `${m.name} · ${waiting} left`, -1, true);
          await save();
          const file: Shared = { uri: m.uri, name: m.name, size: m.size, mime: m.mime || "application/octet-stream", deletable: false };
          try {
            let id = "";
            // the server out of reach mid-file: wait and try the file again twice before the run gives up
            for (let attempt = 0; ; attempt++) {
              try {
                await stillMine(); // before each file, and again after each wait
                id = await uploadFile(file, s, (itemKey, id) => sealItemKey(s, itemKey, pk, id), () => {
                  if (Date.now() > deadline + 90_000 || (held && N.keepRunningLost()) || !current()) throw new Error("out of time"); // finish next time
                }, (d, t) => N.backupNotify("Backing up", `${m.name} · ${waiting} left`, t ? d / t : -1, true), to);
                break;
              } catch (e) {
                if (attempt >= 2 || !(e instanceof ApiError) || !(e.status === 0 || e.status >= 500) || outOfTime()) throw e;
                console.log(`backup: upload failed (${e.status}) ${e.detail}; trying again`); // ids only, no names
                N.backupNotify("Backing up", "Waiting for the server…", -1, true);
                await new Promise((r) => setTimeout(r, attempt ? 90_000 : 30_000));
              }
            }
            // counted as backed up only once it is certain the file went to c.userId
            await stillMine();
            await indexUploaded(s, id, m.uri, (m.mime ?? "").startsWith("video/"), pk, to); // for search, while the file is at hand
            known.add(print);
            delete status.failures[String(m.id)];
            status.uploaded++; done++; waiting--;
            folder.after = m.id;
            await keep();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (e instanceof ApiError) console.log(`backup: upload failed (${e.status}) ${e.detail}`); // ids only, no names
            if (msg === "out of time") break outer;
            if (msg === OTHER_ACCOUNT) { status.problem = "Signed in with another account. The backup goes on once this account is signed in."; break outer; }
            const tries = (status.failures[String(m.id)] ?? 0) + 1;
            status.failures[String(m.id)] = tries;
            if (e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 401 || e.status === 413)) {
              status.problem = e.status === 413 ? "Your storage on the server is full." : e.status === 401 ? "You were signed out. Open Cipherfilm and sign in to continue the backup." : "Can't reach the server right now. The backup tries again in a few minutes.";
              break outer;
            }
            if (tries >= MAX_TRIES) { // this file can't be read or uploaded: leave it and go on
              status.skipped = [{ name: m.name, reason: msg }, ...status.skipped].slice(0, 50);
              delete status.failures[String(m.id)];
              folder.after = m.id;
              await keep();
            } else {
              status.problem = `${m.name}: ${msg}`;
              break outer;
            }
          }
          await save();
        }
      }
    }
    if (current()) await writeJson(KNOWN(), [...known]);
    if (!status.problem && waiting <= 0) status.lastDone = Date.now();
  } catch (e) {
    status.problem = e instanceof Error ? e.message : String(e);
  } finally {
    if (status.problem) status.problemAt = Date.now();
    // couldn't reach the server: try again in a few minutes, not only at the next periodic run
    if (status.problem && /reach|connect/i.test(status.problem) && current()) N.retryBackupSoon(3);
    console.log(`backup (${trigger}): ${done} uploaded${status.problem ? `, stopped: ${status.problem}` : ""}`); // no names, no keys
    status.running = false; status.current = undefined;
    await save();
    running = false;
    if (holding) letGo("backup");
    N.backupNotifyCancel();
    if (done && current()) N.backupNotify("Backup", done === 1 ? "1 photo or video backed up." : `${done} photos and videos backed up.`, 0, false);
  }
}

export const backupRunning = () => running;

/** How many photos and videos wait in the chosen folders. */
export async function waitingCount(): Promise<number> {
  const c = await loadConfig();
  if (!c?.enabled) return 0;
  let n = 0;
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
