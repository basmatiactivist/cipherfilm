import { Icon, IconName } from "./icons";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import * as auth from "./auth";
import { mem } from "./state";
import { mapProvider, PRIVACY_URL, setMapOn, useMapOn } from "./map/consent";
import { Loader, Loading } from "./loader";
import { BackupReport, backupState } from "./backup";
import { explicitChosen, indexChecked, loadPeople, refreshIndex, searchFamily, setExplicit } from "./people/people";
import { vectorCount } from "./search/content";
import { TEXT_MODELS } from "./search/rank";
import { Card, ErrorLine, Field, KeepButton, NewPasswordFields, Submit, VersionLine, fmtGB, passwordProblem, useAction } from "./components";

type Nav = (to: string) => void;

export function Setup({ onKeys }: { onKeys: (k: auth.PendingKey) => void }) {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const { busy, error, setError, run } = useAction();
  return (
    <Card title="Set up Cipherfilm" sealed>
      <p>Creates the administrator account. The setup token is in the server log, after <em>FIRST-TIME SETUP</em>.</p>
      <form onSubmit={(e) => {
        e.preventDefault();
        const p = passwordProblem(pw, pw2);
        if (p) return setError(p);
        run(async () => onKeys(await auth.setup(token, email, pw)));
      }}>
        <Field label="Setup token" id="token" value={token} onInput={setToken} autocomplete="off" autofocus />
        <Field label="E-mail" id="email" type="email" value={email} onInput={setEmail} autocomplete="username" hint="Only used to sign in. Cipherfilm never sends e-mail." />
        <NewPasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
        <ErrorLine text={error} />
        <Submit busy={busy} label="Create account" busyLabel="Creating keys…" />
      </form>
    </Card>
  );
}

export function Invite({ token, onKeys, nav }: { token: string; onKeys: (k: auth.PendingKey) => void; nav: Nav }) {
  const [email, setEmail] = useState<string | null>(null);
  const [bad, setBad] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const { busy, error, setError, run } = useAction();
  useEffect(() => {
    auth.inviteEmail(token).then(setEmail, () => setBad("This invite link has expired or was already used. Ask for a new one."));
  }, [token]);
  if (bad) return <Card title="Invite not valid"><p>{bad}</p><p class="aside"><a href="/" onClick={(e) => { e.preventDefault(); nav("/"); }}>Go to sign in</a></p></Card>;
  if (email === null) return <Card title="Accept your invite"><Loading inline label="Checking your invite…" /></Card>;
  return (
    <Card title="Create your account" sealed>
      <p>You've been invited to Cipherfilm. Choose a password.</p>
      <form onSubmit={(e) => {
        e.preventDefault();
        const p = passwordProblem(pw, pw2);
        if (p) return setError(p);
        run(async () => onKeys(await auth.acceptInvite(token, email, pw)));
      }}>
        <Field label="E-mail" id="email" type="email" value={email} onInput={() => {}} readOnly autocomplete="username" />
        <NewPasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
        <ErrorLine text={error} />
        <Submit busy={busy} label="Create account" busyLabel="Creating keys…" />
      </form>
    </Card>
  );
}

/** Shows a new recovery key; a replacement is stored only on Continue, after "I've saved it", so until then the
 *  previous key keeps working. A new account's key was stored with the account (auth.PendingKey). */
export function RecoveryKey({ pending, onDone, title = "Save your recovery key", replacing = false }: { pending: auth.PendingKey; onDone: () => void; title?: string; replacing?: boolean }) {
  const { words, email } = pending;
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  const text = words.join(" ");
  const file = `Cipherfilm recovery key for ${email}\n\n${words.map((w, i) => `${i + 1}. ${w}`).join("\n")}\n\nKeep this somewhere safe and private. Anyone with it can reset your password.\n`;
  return (
    <Card title={title} sealed wide>
      <p class="lead">The only way back in if you forget your password.</p>
      <ol class="words" aria-label="Recovery key, 24 words in order">
        {words.map((w, i) => <li key={i}><span class="n">{i + 1}</span>{w}</li>)}
      </ol>
      <div class="row no-print">
        <button class="btn secondary" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy"}</button>
        <a class="btn secondary" download="cipherfilm-recovery-key.txt" href={"data:text/plain;charset=utf-8," + encodeURIComponent(file)}>Download</a>
        <button class="btn secondary" onClick={() => window.print()}>Print</button>
      </div>
      <p class="warning"><strong>If you lose both your password and your recovery key, your photos are lost.</strong> Not even the administrator can recover them.</p>
      {replacing && <p class="small">Server backups made before today still need your old password or old recovery key. Keep the old key until those backups are gone.</p>}
      <label class="check no-print"><input type="checkbox" checked={saved} onChange={(e) => setSaved((e.target as HTMLInputElement).checked)} /> I've saved my recovery key somewhere safe</label>
      {error && <ErrorLine text={`The new key isn't saved yet. ${error} Press Continue to try again.`} />}
      <button class="btn no-print" disabled={!saved || busy} onClick={() => run(async () => { await pending.commit(); onDone(); })}>{busy ? <><Loader />Saving…</> : "Continue"}</button>
    </Card>
  );
}

export function Recover({ nav, onKeys }: { nav: Nav; onKeys: (k: auth.PendingKey) => void }) {
  const [email, setEmail] = useState("");
  const [words, setWords] = useState("");
  const [handle, setHandle] = useState<auth.RecoveryHandle | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const { busy, error, setError, run } = useAction();
  const count = words.trim() ? words.trim().split(/\s+/).length : 0;
  const back = <p class="aside"><a href="/" onClick={(e) => { e.preventDefault(); nav("/"); }}>Back to sign in</a></p>;
  if (!handle) {
    return (
      <Card title="Reset your password" sealed>
        <p>Enter your e-mail and your 24-word recovery key. Your photos stay as they are.</p>
        <form onSubmit={(e) => { e.preventDefault(); run(async () => setHandle(await auth.recoverStart(email, words))); }}>
          <Field label="E-mail" id="email" type="email" value={email} onInput={setEmail} autocomplete="username" autofocus />
          <div class="field">
            <label for="words">Recovery key</label>
            <textarea id="words" name="words" rows={4} value={words} required spellcheck={false} autocapitalize="none" autocomplete="off"
              aria-describedby="words-hint" onInput={(e) => setWords((e.target as HTMLTextAreaElement).value)} />
            <p class="hint" id="words-hint">{count} of 24 words. Paste them all, separated by spaces.</p>
          </div>
          <ErrorLine text={error} />
          <Submit busy={busy} label="Check recovery key" busyLabel="Checking…" />
        </form>
        <p class="warning small">If you lose both your password and your recovery key, your photos are lost.</p>
        {back}
      </Card>
    );
  }
  return (
    <Card title="Choose a new password" sealed>
      <p>Recovery key accepted. Choose a new password. You'll get a <strong>new</strong> recovery key, and the old one stops working.</p>
      <form onSubmit={(e) => {
        e.preventDefault();
        const p = passwordProblem(pw, pw2);
        if (p) return setError(p);
        run(async () => onKeys(await auth.recoverFinish(handle, pw)));
      }}>
        <NewPasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
        <ErrorLine text={error} />
        <Submit busy={busy} label="Set new password" busyLabel="Creating keys…" />
      </form>
    </Card>
  );
}

export function Account() {
  const [kit, setKit] = useState<auth.PendingKey | null>(null);
  if (kit) return <RecoveryKey pending={kit} title="Save your new recovery key" replacing onDone={() => setKit(null)} />;
  return (
    <div class="settings">
      <section class="panel profile" aria-label="You">
        <span class="avatar" aria-hidden="true">{mem.me!.user.email.slice(0, 1).toUpperCase()}</span>
        <div><strong class="email">{mem.me!.user.email}</strong><p class="small">{mem.me!.user.role === "admin" ? "Administrator" : "Member"}. Only you can see your photos.</p></div>
      </section>
      {/* the public demo login: one stranger must not lock out the next (the server refuses these anyway) */}
      {!mem.me!.demo && <RecoveryKeyPanel onNew={setKit} />}
      {!mem.me!.demo && <ChangePassword />}
      {!mem.me!.demo && <DevicesPanel />}
      <SearchPanel />
      {mem.me!.map && <MapPanel />}
      <StoragePanel />
      {!mem.me!.demo && <DeleteAccount />}
      <VersionLine server={mem.me!.server_version} />
    </div>
  );
}

function MapPanel() {
  const on = useMapOn();
  return (
    <Acc icon="map" title="Map" sub={on ? "On in this browser" : "Off"}>
      <label class="check"><input type="checkbox" checked={on} onChange={(e) => setMapOn((e.target as HTMLInputElement).checked)} /> Show the map and the small maps in a photo's details</label>
      <p class="hint">Loads map images from {mapProvider() || "the map server"}, which sees this device's IP address and the areas you look at, including roughly where a photo was taken when you open its details. Photo locations stay encrypted and are only drawn here. <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy policy</a></p>
      <p class="hint small">Map data © OpenStreetMap contributors, tiles OpenFreeMap / OpenMapTiles, drawn with MapLibre GL JS (BSD-3-Clause). Place names: GeoNames (geonames.org), CC BY 4.0.</p>
    </Acc>
  );
}

function ChangePassword() {
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useAction();
  return (
    <Acc icon="lock" title="Change password" sub="Signs out your other devices">
      <p>Your photos stay as they are. Your other devices are signed out.</p>
      <form onSubmit={(e) => {
        e.preventDefault();
        setDone(false);
        const p = passwordProblem(pw, pw2);
        if (p) return setError(p);
        run(async () => { await auth.changePassword(cur, pw); setCur(""); setPw(""); setPw2(""); setDone(true); });
      }}>
        <Field label="Current password" id="current" type="password" value={cur} onInput={setCur} autocomplete="current-password" />
        <NewPasswordFields label="New password" pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
        <ErrorLine text={error} />
        {done && <p class="ok" role="status">Password changed.</p>}
        <Submit busy={busy} label="Change password" busyLabel="Changing…" />
      </form>
    </Acc>
  );
}

/** Deletes the account and everything in it from this server, permanently (Google Play's account deletion rule, too). */
function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [sure, setSure] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Acc icon="trash" title="Delete account" sub="Delete your account and all your photos">
      <p class="warning">Deletes your account and <strong>all your photos, videos, albums, people and search data</strong> from this server right away. Not even an administrator can bring them back. All your devices are signed out and delete what they keep.</p>
      <p>Download anything you want to keep first. Server backups an administrator made expire on their own schedule.</p>
      {mem.me!.user.role === "admin" && <p class="hint">If you are the only administrator, make someone else an administrator first.</p>}
      {!open ? (
        <button class="btn secondary warn" onClick={() => setOpen(true)}>Delete my account…</button>
      ) : (
        <form onSubmit={(e) => {
          e.preventDefault();
          run(async () => { await auth.deleteAccount(cur); window.dispatchEvent(new Event("cf-account-deleted")); });
        }}>
          <Field label="Your password" id="del-password" type="password" value={cur} onInput={setCur} autocomplete="current-password" autofocus />
          <label class="check"><input type="checkbox" checked={sure} onChange={(e) => setSure((e.target as HTMLInputElement).checked)} /> I understand my photos and videos are deleted permanently</label>
          <ErrorLine text={error} />
          <div class="row">
            <button type="submit" class="btn danger" disabled={busy || !sure || !cur}>{busy ? <><Loader />Deleting…</> : "Delete account"}</button>
            <button type="button" class="btn secondary" onClick={() => { setOpen(false); setCur(""); setSure(false); }}>Cancel</button>
          </div>
        </form>
      )}
    </Acc>
  );
}

function RecoveryKeyPanel({ onNew }: { onNew: (k: auth.PendingKey) => void }) {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Acc icon="key" title="Recovery key" sub="The only way back in if you forget your password">
      <p>Keep it somewhere safe, like a password manager or a printed copy. It can't be shown again, but you can make a new one. <strong>The old key stops working once you save the new one.</strong></p>
      {!open ? (
        <button class="btn secondary" onClick={() => setOpen(true)}>Make a new recovery key…</button>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); run(async () => onNew(await auth.rotateRecoveryKey(cur))); }}>
          <Field label="Your password" id="rk-password" type="password" value={cur} onInput={setCur} autocomplete="current-password" autofocus />
          <ErrorLine text={error} />
          <div class="row">
            <Submit busy={busy} label="Make new recovery key" busyLabel="Creating…" />
            <button type="button" class="btn secondary" onClick={() => { setOpen(false); setCur(""); }}>Cancel</button>
          </div>
        </form>
      )}
    </Acc>
  );
}


function StoragePanel() {
  const [u, setU] = useState<{ used_bytes: number; quota_bytes: number; unlimited: boolean } | null>(null);
  useEffect(() => { auth.loadUsage().then(setU, () => {}); }, []);
  return (
    <Acc icon="cloud" title="Storage" sub="How much you use">
      {u && !u.unlimited && u.quota_bytes > 0 && <div class="meterbar big"><div style={{ width: `${Math.min(100, Math.round((u.used_bytes / u.quota_bytes) * 100))}%` }} /></div>}
      {u ? <p class="usage">{fmtGB(u.used_bytes)} used{u.unlimited ? ", no limit" : ` of ${fmtGB(u.quota_bytes)}`}. Items in the trash count until they're deleted.</p> : <div class="usage"><Loading inline label="Checking…" /></div>}
    </Acc>
  );
}

interface Device { id: string; device: string; created_at: number; last_seen: number; current: boolean; indexer: boolean }

const seenAgo = (sec: number) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
  if (m < 2) return "active now";
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return h === 1 ? "an hour ago" : `${h} hours ago`;
  return new Date(sec * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** Every device signed in to this account (docs/SEARCH.md "Devices"): sign out one that is lost or not yours. It
 *  deletes what it keeps of the library the next time it reaches the server. */
function DevicesPanel() {
  const [list, setList] = useState<Device[] | null>(null);
  const [ask, setAsk] = useState<Device | "others" | null>(null);
  const { busy, error, run } = useAction();
  const load = () => api<{ sessions: Device[] }>("GET", "/api/me/sessions").then((r) => setList(r.sessions), () => setList([]));
  useEffect(() => { load(); }, []);
  const others = list?.filter((d) => !d.current).length ?? 0;
  return (
    <Acc icon="shield" title="Devices" sub="Where you're signed in">
      {!list ? <Loading inline label="Checking…" /> : (
        <ul class="devices">
          {list.map((d) => (
            <li key={d.id}>
              <div class="devtext">
                <strong>{d.device || "Unknown device"}</strong>
                <span class="small">
                  {d.current ? "This browser" : seenAgo(d.last_seen)} · signed in {new Date(d.created_at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                  {d.indexer && " · indexes your photos for search"}
                </span>
              </div>
              {!d.current && (ask === d ? (
                <span class="row">
                  <button class="btn danger small" disabled={busy} onClick={() => run(async () => { await api("DELETE", `/api/me/sessions/${d.id}`); setAsk(null); await load(); })}>Sign out</button>
                  <button class="btn secondary small" onClick={() => setAsk(null)}>Cancel</button>
                </span>
              ) : <button class="btn secondary small" onClick={() => setAsk(d)}>Sign out…</button>)}
            </li>
          ))}
        </ul>
      )}
      {ask && ask !== "others" && <p class="hint">{ask.device || "This device"} must sign in again, and deletes what it keeps of your library (thumbnails, search) the next time it reaches the server.</p>}
      {others > 1 && (ask === "others" ? (
        <div class="row">
          <button class="btn danger" disabled={busy} onClick={() => run(async () => { await api("POST", "/api/me/sessions/end-others"); setAsk(null); await load(); })}>Sign out {others} devices</button>
          <button class="btn secondary" onClick={() => setAsk(null)}>Cancel</button>
        </div>
      ) : <button class="btn secondary" onClick={() => setAsk("others")}>Sign out all other devices…</button>)}
      <p class="hint">Search: one device indexes your photos and stores the index encrypted; the others use it. To change which one, open Search and people in that app and choose “Index here”.</p>
      <ErrorLine text={error} />
    </Acc>
  );
}

/** Search by what is in a photo: what this browser can find, and (if an admin allows it) explicit search. */
function SearchPanel() {
  const [, setTick] = useState(0);
  const [explicit, setExplicitState] = useState<boolean | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    let alive = true;
    Promise.all([refreshIndex(true), loadPeople()]).then(() => alive && setExplicitState(explicitChosen()), () => alive && setExplicitState(explicitChosen()));
    return () => { alive = false; };
  }, []);
  const allowed = !!mem.me?.user.nsfw;
  const family = searchFamily();
  const n = vectorCount(family), other = vectorCount(family === "mcs2" ? "laionb32" : "mcs2");
  return (
    <Acc icon="search" title="Search" sub="Find photos by what is in them">
      {!indexChecked() ? <Loading inline label="Checking…" /> : n === 0 && other === 0 ? (
        <p>To find photos by what's in them (dog, beach, birthday), <strong>turn on search in the Android or Mac app</strong> (Search and people). This browser then uses what the app found.</p>
      ) : (
        <p>{n === 1 ? "1 photo" : `${n} photos`} can be found by what is in them. Combine with a date or a name, like “beach 2023” or “Anna cake”.{n === 0 && " Your Android or Mac app is still indexing them with the model you chose."} Runs in this browser; your search words never leave it. Downloads {Math.round(TEXT_MODELS[family].size / 1e6)} MB once from Hugging Face.</p>
      )}
      {indexChecked() && n + other > 0 && <p class="hint">Hugging Face sees this browser's IP address, nothing of your photos. Hugging Face is a trademark of Hugging Face, Inc. Cipherfilm is not affiliated with or endorsed by Hugging Face.</p>}
      {allowed && explicit !== null && (
        <>
          <label class="check">
            <input type="checkbox" role="switch" checked={explicit} disabled={busy}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                setExplicitState(on); // at once; put back if saving fails
                run(async () => { try { await setExplicit(on); } catch (x) { setExplicitState(!on); throw x; } setTick((t) => t + 1); });
              }} />
            Explicit search
          </label>
          <p class="hint">Uses a model that also knows explicit content. <strong>This applies to all your devices:</strong> the indexing device (Account › Devices) indexes your whole library again, and search finds fewer photos until it's done. In this browser it's a {Math.round(TEXT_MODELS.laionb32.size / 1e6)} MB download, removed when you sign out.</p>
          <ErrorLine text={error} />
        </>
      )}
    </Acc>
  );
}

function Acc(p: { icon: IconName; title: string; sub: string; children: any }) {
  return (
    <details class="acc">
      <summary>
        <span class="accicon"><Icon name={p.icon} size={22} /></span>
        <span class="acctext"><strong>{p.title}</strong><span>{p.sub}</span></span>
        <span class="chev"><Icon name="chevdown" /></span>
      </summary>
      <div class="accbody">{p.children}</div>
    </details>
  );
}

interface AdminUser { id: string; email: string; role: string; status: string; created_at: number; last_login_at: number; quota_bytes: number; used_bytes: number; item_count: number; nsfw: boolean }


function Storage({ u, onSaved }: { u: AdminUser; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [gb, setGb] = useState(String(Math.round(u.quota_bytes / 1e9)));
  const { busy, error, run } = useAction();
  const limit = u.quota_bytes === 0 ? "no limit" : fmtGB(u.quota_bytes);
  if (!editing) return <span>{fmtGB(u.used_bytes)}{u.quota_bytes === 0 ? " used, no limit" : ` of ${limit}`} · {u.item_count} {u.item_count === 1 ? "item" : "items"} <button class="link small" onClick={() => setEditing(true)} aria-label={`Change storage limit for ${u.email}`}>Change</button></span>;
  return (
    <form class="inline quota" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("PATCH", `/api/admin/users/${u.id}`, { quota_bytes: Math.round(Number(gb) * 1e9) }); setEditing(false); onSaved(); }); }}>
      <label for={`q-${u.id}`}>Limit in GB (0 = no limit)</label>
      <input id={`q-${u.id}`} type="number" min="0" step="1" value={gb} onInput={(e) => setGb((e.target as HTMLInputElement).value)} />
      {error && <p class="error" role="alert">{error}</p>}
      <div class="row"><button class="btn small" type="submit" disabled={busy}>Save</button><button class="btn secondary small" type="button" onClick={() => setEditing(false)}>Cancel</button></div>
    </form>
  );
}
interface AdminInvite { id: string; email: string; expires_at: number; quota_bytes: number }
interface AuditEntry { at: number; actor: string; action: string; target: string; detail: string }
interface ServerStatus extends BackupReport { disk_free_bytes: number; disk_total_bytes: number; data_bytes: number; active_sessions: number; last_backup_at: number; uptime_seconds: number; version?: string }


// ---- Activity: the audit log as sentences, grouped by day ----

const dayLabel = (sec: number) => {
  const d = new Date(sec * 1000), today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
};

function byDay(list: AuditEntry[]): [string, AuditEntry[]][] {
  const out: [string, AuditEntry[]][] = [];
  for (const a of list) {
    const day = dayLabel(a.at);
    if (out.length && out[out.length - 1][0] === day) out[out.length - 1][1].push(a);
    else out.push([day, [a]]);
  }
  return out;
}

/** One audit entry as a sentence: "You made anna@… an administrator", "Server console signed out every device of …". */
function describe(a: AuditEntry, myEmail: string): { icon: IconName; text: any; warn?: boolean } {
  const person = (e: string, start = false) => (e === myEmail ? (start ? "You" : "you") : e === "server console" ? (start ? "The server console" : "the server console") : <strong class="email">{e}</strong>);
  const who = person(a.actor, true), t = person(a.target);
  const size = (v: string) => (v === "0" ? "no limit" : fmtGB(Number(v)));
  switch (a.action) {
    case "invited": return { icon: "plus", text: <>{who} invited {t}</> };
    case "joined": return { icon: "user", text: <>{person(a.target, true)} joined</> };
    case "invite revoked": return { icon: "x", text: <>{who} withdrew the invite for {t}</> };
    case "role changed": return { icon: "shield", text: <>{who} made {t} {a.detail === "admin" ? "an administrator" : "a regular user"}</> };
    case "explicit search allowed": return { icon: "search", text: <>{who} allowed explicit search for {t}</> };
    case "explicit search turned off": return { icon: "search", text: <>{who} turned off explicit search for {t}</> };
    case "enabled": return { icon: "check", text: <>{who} enabled {t}</> };
    case "disabled": return { icon: "slash", text: <>{who} disabled {t}</>, warn: true };
    case "deleted": return { icon: "trash", text: <>{who} deleted {t} and everything they stored</>, warn: true };
    case "storage limit changed": return { icon: "cloud", text: <>{who} set the storage limit of {t} to {size(a.detail)}</> };
    case "default limit changed": return { icon: "cloud", text: <>{who} set the default storage limit to {size(a.detail)}</> };
    case "signed out a device": return { icon: "logout", text: <>{who} signed out {a.detail ? <strong>{a.detail}</strong> : "a device"}</> };
    case "signed out other devices": return { icon: "logout", text: <>{who} signed out all other devices</> };
    case "signed out every device": return { icon: "logout", text: <>{who} signed out every device of {t}{a.detail ? ", and they delete what they keep" : ""}</>, warn: !!a.detail };
  }
  return { icon: "info", text: <>{who} {a.action}{a.target ? <> · {t}</> : null}{a.detail ? <span class="small"> ({a.detail})</span> : null}</> };
}

const ago = (ts: number): string => {
  if (!ts) return "never signed in";
  const d = Math.floor((Date.now() / 1000 - ts) / 86400);
  return d <= 0 ? "active today" : d === 1 ? "active yesterday" : `active ${d} days ago`;
};

export function Admin({ section }: { section: "users" | "defaults" | "server" | "activity" }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<{ url: string; email: string; exp: number } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [inviteGb, setInviteGb] = useState("");
  const [defaultQuota, setDefaultQuota] = useState(0);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { busy, error, run } = useAction();
  const load = () => api<{ users: AdminUser[]; invites: AdminInvite[]; default_quota_bytes: number }>("GET", "/api/admin/users").then((r) => { setUsers(r.users); setInvites(r.invites); setDefaultQuota(r.default_quota_bytes); setLoaded(true); });
  const loadMore = () => {
    api<{ entries: AuditEntry[] }>("GET", "/api/admin/audit").then((r) => setAudit(r.entries), () => {});
    api<ServerStatus>("GET", "/api/admin/status").then(setStatus, () => {});
  };
  useEffect(() => { load().catch(() => setLoaded(true)); loadMore(); }, []);
  const changed = () => { load(); loadMore(); };
  // a row action (delete, disable, role, revoke) that fails says so instead of doing nothing
  const [actError, setActError] = useState("");
  const [copied, setCopied] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setActError("");
    try { await fn(); } catch (e) { setActError(e instanceof Error ? e.message : "That didn't work."); }
    changed();
  };
  const me = mem.me!.user.id;
  const stored = users.reduce((n, u) => n + u.used_bytes, 0);
  const items = users.reduce((n, u) => n + u.item_count, 0);
  return (
    <div class="settings admin">
      {status && backupState(status).problem && section !== "server" && <p class="warning small" role="alert">{backupState(status).problem} Details under Server.</p>}
      {section === "users" && (<>
      {!loaded ? <Loading inline label="Loading accounts…" /> : <p class="lead privacy">{users.length} {users.length === 1 ? "person" : "people"} · {fmtGB(stored)} stored · {items} {items === 1 ? "item" : "items"}. Administrators can't see anyone's photos, album names or file names.</p>}
      <section class="panel" aria-labelledby="inv-h">
        <h2 id="inv-h"><Icon name="plus" />Invite someone</h2>
        <p>Cipherfilm doesn't send e-mail. Send the link yourself. It works once and expires after 7 days.</p>
        <form onSubmit={(e) => { e.preventDefault(); run(async () => {
          const gb = inviteGb.trim() === "" ? undefined : Number(inviteGb);
          if (gb !== undefined && (!Number.isFinite(gb) || gb < 0)) throw new Error("Enter the storage limit as a number of GB, or leave it empty.");
          const r = await api<{ token: string; email: string; expires_at: number }>("POST", "/api/admin/invites", { email, ...(gb === undefined ? {} : { quota_bytes: Math.round(gb * 1e9) }) });
          setLink({ url: `${location.origin}/invite/${r.token}`, email: r.email, exp: r.expires_at });
          setEmail(""); setInviteGb(""); changed();
        }); }}>
          <Field label="Their e-mail" id="invite-email" type="email" value={email} onInput={setEmail} autocomplete="off" />
          <Field label="Storage limit in GB (optional)" id="invite-quota" value={inviteGb} onInput={setInviteGb} autocomplete="off" required={false}
            hint={`Leave empty for the default (${defaultQuota ? fmtGB(defaultQuota) : "no limit"}). 0 means no limit.`} />
          <ErrorLine text={error} />
          <Submit busy={busy} label="Create invite link" busyLabel="Creating…" />
        </form>
        {link && (
          <div class="linkbox sealed" role="status">
            <p>Invite link for <strong class="email">{link.email}</strong>, valid until {new Date(link.exp * 1000).toLocaleDateString()}. It's shown only once.</p>
            <input readOnly value={link.url} aria-label="Invite link" onFocus={(e) => (e.target as HTMLInputElement).select()} />
            <button class="btn secondary" onClick={() => navigator.clipboard.writeText(link.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => {})}><Icon name={copied ? "check" : "copy"} size={18} />{copied ? "Copied" : "Copy link"}</button>
          </div>
        )}
      </section>
      {invites.length > 0 && (
        <section class="panel" aria-labelledby="open-h">
          <h2 id="open-h"><Icon name="key" />Open invites</h2>
          <ul class="people">
            {invites.map((i) => (
              <li key={i.id} class="person">
                <span class="avatar" aria-hidden="true">{i.email.slice(0, 1).toUpperCase()}</span>
                <div class="pmain"><strong class="email">{i.email}</strong><span class="small">Waiting, link valid until {new Date(i.expires_at * 1000).toLocaleDateString()}. Limit: {i.quota_bytes ? fmtGB(i.quota_bytes) : "none"}.</span></div>
                <div class="pactions"><button class="btn secondary small" onClick={() => act(() => api("DELETE", `/api/admin/invites/${i.id}`))}><Icon name="x" size={18} />Revoke<span class="sr"> invite for {i.email}</span></button></div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section class="panel" aria-labelledby="usr-h">
        <h2 id="usr-h"><Icon name="users" />Users</h2>
        <p class="hint">Explicit search is off for everyone. Allow it for someone, and they can turn on an uncensored search model themselves.</p>
        {actError && <p class="error" role="alert">{actError}</p>}
        <ul class="people">
          {users.map((u) => (
            <li key={u.id} class="person" aria-label={u.email}>
              <span class="avatar" aria-hidden="true">{u.email.slice(0, 1).toUpperCase()}</span>
              <div class="pmain">
                <strong class="email">{u.email}</strong>
                <span class="pmeta"><span class={"pill " + u.role}>{u.role}</span><span class={"pill " + u.status}>{u.status}</span>{u.nsfw && <span class="pill">explicit search</span>}<span class="small">{ago(u.last_login_at)}</span></span>
                <Storage u={u} onSaved={changed} />
              </div>
              <div class="pactions">
                {/* off for everyone by default; the person still turns it on in their app. Admins may allow it for themselves. */}
                {confirm !== u.id && (
                  <button class="btn secondary small" aria-pressed={u.nsfw} title="An uncensored search model in the Android and Mac apps and the web. Off for everyone by default."
                    onClick={() => act(() => api("PATCH", `/api/admin/users/${u.id}`, { nsfw: !u.nsfw }))}>
                    <Icon name="search" size={18} />{u.nsfw ? "Turn off explicit search" : "Allow explicit search"}<span class="sr"> for {u.email}</span>
                  </button>
                )}
                {u.id !== me && (confirm === u.id ? (
                    <>
                      <span class="small">Delete {u.email} and everything they stored?</span>
                      <button class="btn danger small" onClick={() => act(async () => { await api("DELETE", `/api/admin/users/${u.id}`); setConfirm(null); })}>Delete</button>
                      <KeepButton label="Cancel" onClick={() => setConfirm(null)} />
                    </>
                  ) : (
                    <>
                      <button class="btn secondary small" onClick={() => act(() => api("PATCH", `/api/admin/users/${u.id}`, { status: u.status === "active" ? "disabled" : "active" }))}><Icon name={u.status === "active" ? "slash" : "check"} size={18} />{u.status === "active" ? "Disable" : "Enable"}</button>
                      <button class="btn secondary small" onClick={() => act(() => api("PATCH", `/api/admin/users/${u.id}`, { role: u.role === "admin" ? "user" : "admin" }))}><Icon name="shield" size={18} />{u.role === "admin" ? "Make regular user" : "Make admin"}</button>
                      <button class="btn secondary small warn" onClick={() => setConfirm(u.id)}><Icon name="trash" size={18} />Delete…</button>
                    </>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
      </>)}
      {section === "defaults" && <DefaultLimit current={defaultQuota} onSaved={changed} />}
      {section === "server" && (
      <section class="panel" aria-labelledby="srv-h">
        <h2 id="srv-h"><Icon name="cloud" />Server</h2>
        {status ? (
          <>
            {status.disk_total_bytes > 0 && <div class="meterbar big" role="img" aria-label={`Disk ${fmtGB(status.disk_total_bytes - status.disk_free_bytes)} of ${fmtGB(status.disk_total_bytes)} used`}><div style={{ width: `${Math.round(((status.disk_total_bytes - status.disk_free_bytes) / status.disk_total_bytes) * 100)}%` }} /></div>}
            <dl class="facts">
              <dt>Disk free</dt><dd>{fmtGB(status.disk_free_bytes)} of {fmtGB(status.disk_total_bytes)}</dd>
              <dt>Cipherfilm data</dt><dd>{fmtGB(status.data_bytes)}</dd>
              <dt>Signed-in devices</dt><dd>{status.active_sessions}</dd>
              <dt>Version</dt><dd>{status.version ?? "unknown"}</dd>
              <dt>Running for</dt><dd>{status.uptime_seconds >= 86400 ? `${Math.floor(status.uptime_seconds / 86400)} days` : status.uptime_seconds >= 3600 ? `${Math.floor(status.uptime_seconds / 3600)} hours` : `${Math.floor(status.uptime_seconds / 60)} minutes`}</dd>
              <dt>Off-site backup</dt><dd class={backupState(status).problem ? "bad" : undefined}>{backupState(status).text}</dd>
              <dt>Database snapshot</dt><dd>{status.last_backup_at ? new Date(status.last_backup_at * 1000).toLocaleString() : "None yet. Written by scripts/backup.sh or the nightly backup."}</dd>
            </dl>
          </>
        ) : <Loading inline label="Checking…" />}
      </section>)}
      {section === "activity" && (
      <section class="panel" aria-labelledby="act-h">
        <h2 id="act-h"><Icon name="restore" />Activity</h2>
        {audit.length === 0 ? <p class="small">Nothing yet. Invites, role and limit changes, and removals show up here.</p> : (
          <div class="activity">
            {byDay(audit).map(([day, list]) => (
              <section key={day} aria-label={day}>
                <h3>{day}</h3>
                <ul>
                  {list.map((a, i) => {
                    const d = describe(a, mem.me!.user.email);
                    return (
                      <li key={i}>
                        <time dateTime={new Date(a.at * 1000).toISOString()} title={new Date(a.at * 1000).toLocaleString()}>{new Date(a.at * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
                        <span class={"acticon" + (d.warn ? " warn" : "")} aria-hidden="true"><Icon name={d.icon} size={16} /></span>
                        <span class="acttext">{d.text}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>)}
    </div>
  );
}

function DefaultLimit({ current, onSaved }: { current: number; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [gb, setGb] = useState("");
  const { busy, error, run } = useAction();
  return (
    <section class="panel" aria-labelledby="def-h">
      <h2 id="def-h"><Icon name="cloud" />Default storage limit</h2>
      <p>New people get {current ? fmtGB(current) : "no limit"} unless the invite says otherwise. People who already joined keep their limit.</p>
      {!editing ? (
        <button class="btn secondary" onClick={() => { setGb(String(Math.round(current / 1e9))); setEditing(true); }}>Change default…</button>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); run(async () => {
          const n = Number(gb);
          if (!Number.isFinite(n) || n < 0) throw new Error("Enter a number of GB (0 means no limit).");
          await api("PATCH", "/api/admin/settings", { default_quota_bytes: Math.round(n * 1e9) });
          setEditing(false); onSaved();
        }); }}>
          <Field label="Default limit in GB (0 = no limit)" id="default-quota" value={gb} onInput={setGb} autocomplete="off" />
          <ErrorLine text={error} />
          <div class="row"><Submit busy={busy} label="Save default" busyLabel="Saving…" /><button type="button" class="btn secondary" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      )}
    </section>
  );
}
