import { Icon, IconName } from "./icons";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api";
import * as auth from "./auth";
import { mem } from "./state";
import { mapProvider, PRIVACY_URL, setMapOn, useMapOn } from "./map/consent";
import { setMemoriesOn, useMemoriesOn } from "./memories/setting";
import { browserAlertsPossible, setBrowserAlerts, useBrowserAlerts } from "./noticeAlerts";
import { Loader, Loading } from "./loader";
import { BackupReport, backupState } from "./backup";
import { explicitChosen, indexChecked, loadPeople, refreshIndex, searchFamily, setExplicit } from "./people/people";
import { forgetContentModels, loadModel, vectorCount } from "./search/content";
import { adoptCached, agreeModels, downloaded, mb, modelsAgreed, useModelConsent } from "./search/consent";
import { ModelConsent } from "./search/consentui";
import { TEXT_MODELS, TOKENIZER } from "./search/rank";
import * as tf from "./twofactor";
import * as pk from "./passkeys";
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

/** open: the panel a notice led to ("devices" or "2fa"). */
export function Account({ open }: { open?: string }) {
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
      {!mem.me!.demo && <ChangePassword open={open === "password"} />}
      {!mem.me!.demo && <TwoFactorPanel open={open === "2fa"} />}
      {!mem.me!.demo && <DevicesPanel open={open === "devices"} />}
      <SearchPanel />
      {mem.me!.map && <MapPanel />}
      <MemoriesPanel />
      <StoragePanel />
      {!mem.me!.demo && <DeleteAccount />}
      <VersionLine server={mem.me!.server_version} />
      {/* the sources ask to be named: GeoNames (CC BY 4.0) for the place names, always used; OpenStreetMap (ODbL) for the map */}
      <p class="hint small">
        Place names: GeoNames (geonames.org), CC BY 4.0.
        {mem.me!.map ? (mapProvider() === "OpenFreeMap" ? " Map data © OpenStreetMap contributors, tiles OpenFreeMap / OpenMapTiles, drawn with MapLibre GL JS (BSD-3-Clause)." : " Map drawn with MapLibre GL JS (BSD-3-Clause); its data is credited on the map.") : ""}
      </p>
    </div>
  );
}

function MapPanel() {
  const on = useMapOn();
  return (
    <Acc icon="map" title="Map" sub={on ? "On in this browser" : "Off"}>
      <label class="check"><input type="checkbox" checked={on} onChange={(e) => setMapOn((e.target as HTMLInputElement).checked)} /> Show the map and the small maps in a photo's details</label>
      <p class="hint">Your photos on a map. Map images from {mapProvider() || "the map server"}; what it sees is in the <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">privacy policy</a>.</p>
    </Acc>
  );
}

function MemoriesPanel() {
  const on = useMemoriesOn();
  return (
    <Acc icon="photos" title="Memories" sub={on ? "On in this browser" : "Off in this browser"}>
      <label class="check"><input type="checkbox" checked={on} onChange={(e) => setMemoriesOn((e.target as HTMLInputElement).checked)} /> Show “On this day” above the timeline</label>
      <p class="hint">Photos from around today's date in earlier years. Worked out in this browser from the encrypted dates; the server learns nothing about it.</p>
    </Acc>
  );
}

function ChangePassword({ open }: { open?: boolean }) {
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useAction();
  return (
    <Acc icon="lock" title="Change password" sub="Signs out your other devices" open={open}>
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

/** Two-step sign-in: a code from an authenticator app, or a passkey, at every new sign-in. Unlocking this browser again
 *  doesn't ask. */
type TfMode = "" | "setup" | "qr" | "off" | "new" | "codes" | "addkey" | "removeapp" | { remove: pk.Passkey } | { rename: pk.Passkey };

function TwoFactorPanel({ open }: { open?: boolean }) {
  const [st, setSt] = useState<tf.TwoFactorStatus | null>(null);
  const [keys, setKeys] = useState<pk.Passkey[]>([]);
  const [mode, setMode] = useState<TfMode>("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState<tf.TwoFactorSetup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState("");
  // once the person worked in it, the panel stays open when a step ends (it would close and hide the new state)
  const [stay, setStay] = useState(false);
  useEffect(() => { if (mode) setStay(true); }, [mode]);
  const { busy, error, setError, run } = useAction();
  const load = () => {
    tf.status().then((s) => { setSt(s); if (mem.me) mem.me.two_factor = s.enabled; }, () => {});
    pk.list().then((l) => setKeys(l.passkeys), () => setKeys([]));
  };
  useEffect(() => { load(); }, []);
  const reset = () => { setMode(""); setCode(""); setSecret(null); setError(""); setSaved(false); setCopied(""); };
  const done = () => { reset(); load(); };
  const showCodes = (c: string[] | null) => { if (c && c.length) { setCodes(c); setMode("codes"); } else done(); };
  const copy = (what: string, text: string) => navigator.clipboard.writeText(text).then(() => setCopied(what), () => setCopied(""));
  const on = st?.enabled ?? !!mem.me!.two_factor;
  const totp = st?.totp ?? on; // an older server: on means the app
  const canPasskey = pk.passkeysSupported();
  const hereKeys = keys.filter((k) => k.here).length;
  if (st && !st.available) return null;
  const email = mem.me!.user.email;
  const methods = [totp && "a code from your app", keys.length > 0 && "a passkey"].filter(Boolean).join(" or ");

  if (mode === "codes") {
    return (
      <Acc icon="key" title="Two-step sign-in" sub="Save your recovery codes" open>
        <p>Each of these codes signs you in once instead of a code from your app or a passkey, for when your phone is lost. <strong>They're shown only now.</strong></p>
        <ol class="words codes" aria-label="Recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
        <div class="row">
          <button class="btn secondary" onClick={() => copy("codes", codes.join("\n"))}>{copied === "codes" ? "Copied" : "Copy"}</button>
          <a class="btn secondary" download="cipherfilm-recovery-codes.txt" href={"data:text/plain;charset=utf-8," + encodeURIComponent(tf.codesFile(email, codes))}>Download</a>
        </div>
        <label class="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved((e.target as HTMLInputElement).checked)} /> I've saved these codes somewhere safe</label>
        <button class="btn" disabled={!saved} onClick={() => { setCodes([]); done(); }}>Done</button>
      </Acc>
    );
  }
  const proofFor = (intro: string, submit: string, act: (p: pk.Proof) => Promise<void>, danger = false, second = on) => (
    <ProofForm intro={intro} submit={submit} danger={danger} second={second} passkey={canPasskey && hereKeys > 0} onSubmit={act} onCancel={reset} />
  );
  return (
    <Acc icon="key" title="Two-step sign-in" sub={on ? `On: ${methods} at every new sign-in` : "Off"} open={open || stay || mode !== "" || undefined}>
      {mode === "" && !on && (
        <>
          <p>Ask for a second step when you sign in on a new device or browser: a 6-digit code from an authenticator app (such as Aegis, 2FAS or Google Authenticator), or a passkey in your password manager or on a security key. Unlocking a device that is already signed in doesn't ask for it. Your password still unlocks your photos.</p>
          <div class="row">
            <button class="btn secondary" onClick={() => setMode("setup")}>Use an authenticator app…</button>
            {canPasskey && <button class="btn secondary" onClick={() => setMode("addkey")}>Use a passkey…</button>}
          </div>
        </>
      )}
      {mode === "" && on && (
        <>
          <p>A new sign-in asks for {methods}. {st ? `${st.recovery_codes_left} of 10 recovery codes left.` : ""}</p>
          {st && st.recovery_codes_left <= 2 && <p class="warning small">Few recovery codes left. Make new ones so you aren't locked out if you lose your phone.</p>}
          <h3 class="subhead">Authenticator app</h3>
          {totp ? (
            <div class="row">
              <span class="small">On</span>
              {keys.length > 0 && <button class="btn secondary" onClick={() => setMode("removeapp")}>Remove…</button>}
            </div>
          ) : <button class="btn secondary" onClick={() => setMode("setup")}>Add an authenticator app…</button>}
          <h3 class="subhead">Passkeys</h3>
          {keys.length > 0 && (
            <ul class="devices passkeys">
              {keys.map((k) => (
                <li key={k.id}>
                  <div class="devtext">
                    <strong>{k.name}</strong>
                    <p class="small">Added {new Date(k.created_at * 1000).toLocaleDateString()}{k.last_used_at ? `, last used ${new Date(k.last_used_at * 1000).toLocaleDateString()}` : ", not used yet"}{k.here ? "" : ` · for ${k.rp_id}`}</p>
                  </div>
                  <div class="row">
                    <button class="btn secondary" onClick={() => setMode({ rename: k })}>Rename</button>
                    <button class="btn secondary warn" onClick={() => setMode({ remove: k })}>Remove…</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {canPasskey ? <button class="btn secondary" onClick={() => setMode("addkey")}>Add a passkey…</button>
            : <p class="small">This browser can't use passkeys here{location.protocol === "https:" ? "" : " (it needs the https address)"}.</p>}
          <h3 class="subhead">Recovery codes</h3>
          <div class="row">
            <button class="btn secondary" onClick={() => setMode("new")}>New recovery codes…</button>
            <button class="btn secondary warn" onClick={() => setMode("off")}>Turn off…</button>
          </div>
        </>
      )}
      {mode === "setup" && proofFor("", "Continue", async (p) => { setSecret(await tf.setup(p)); setMode("qr"); })}
      {mode === "qr" && secret && (() => {
        const qr = tf.qrFor(secret.uri);
        return (
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { const c = await tf.enable(code); setCode(""); setSecret(null); showCodes(c); }); }}>
            <p>Scan this code with your authenticator app, or add it with the button on a phone, or type the key into it. Then enter the 6-digit code the app shows.</p>
            {/* on a phone the app is on the same device: the otpauth: address opens it (or a password manager) directly */}
            <a class="btn touch-only" href={secret.uri}>Open in authenticator app</a>
            {/* drawn here from the key: the key never goes to a QR service */}
            <svg class="qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="QR code for your authenticator app" shape-rendering="crispEdges">
              <rect width={qr.size} height={qr.size} fill="#fff" />
              <path d={qr.d} fill="#000" />
            </svg>
            <p class="secret"><span class="small">Key</span> <code>{tf.groupSecret(secret.secret)}</code> <button type="button" class="link" onClick={() => copy("key", secret.secret)}>{copied === "key" ? "Copied" : "Copy"}</button></p>
            <Field label="Code from the app" id="tf-code" value={code} onInput={setCode} autocomplete="one-time-code" inputmode="numeric" pattern="[0-9 ]*" maxLength={7} autofocus={!tf.touchDevice()} />
            <ErrorLine text={error} />
            <div class="row">
              <Submit busy={busy} label="Turn on" busyLabel="Checking…" />
              <button type="button" class="btn secondary" onClick={reset}>Cancel</button>
            </div>
          </form>
        );
      })()}
      {mode === "addkey" && <AddPasskey second={on} passkey={canPasskey && hereKeys > 0} onDone={showCodes} onCancel={reset} />}
      {mode === "off" && proofFor("Turning it off removes the authenticator app, your passkeys and recovery codes: your password alone signs in again.", "Turn off",
        async (p) => { await tf.disable(p); done(); }, true)}
      {mode === "new" && proofFor("Your old recovery codes stop working.", "Make new codes", async (p) => { setCodes(await tf.newCodes(p)); setMode("codes"); })}
      {mode === "removeapp" && proofFor("A new sign-in then asks for a passkey (or a recovery code).", "Remove the app", async (p) => { await tf.removeApp(p); done(); }, true)}
      {typeof mode === "object" && "remove" in mode && proofFor(
        keys.length === 1 && !totp ? `Removing "${mode.remove.name}", your only second step, turns two-step sign-in off.` : `Remove "${mode.remove.name}"? It can't be used to sign in any more.`,
        "Remove", async (p) => { await pk.remove(mode.remove.id, p); done(); }, true)}
      {typeof mode === "object" && "rename" in mode && <RenamePasskey key={mode.rename.id} k={mode.rename} onDone={done} onCancel={reset} />}
    </Acc>
  );
}

/** The password and, when two-step sign-in is on, a second step: a code (from the app or a recovery code) or a passkey. */
function ProofForm(p: { intro: string; submit: string; danger?: boolean; second: boolean; passkey: boolean; onSubmit: (proof: pk.Proof) => Promise<void>; onCancel: () => void }) {
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const { busy, error, run } = useAction();
  // the passkey's challenge is fetched ahead, so the browser's dialog opens right on the tap (some allow it only then)
  const challenge = useRef<Promise<Record<string, any>> | null>(null);
  const prepare = () => { if (p.second && p.passkey) { challenge.current = api<{ options: Record<string, any> }>("POST", "/api/me/2fa/passkey", {}).then((r) => r.options); challenge.current.catch(() => {}); } };
  useEffect(prepare, []);
  const withPasskey = () => run(async () => {
    try {
      const answer = await pk.getPasskey(await (challenge.current ?? Promise.reject(new Error("Try again."))));
      await p.onSubmit({ current_auth: await auth.passwordProof(pw), passkey: answer });
    } finally { prepare(); } // a challenge is answered once
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); run(async () => p.onSubmit({ current_auth: await auth.passwordProof(pw), ...(p.second ? { code: code.trim() } : {}) })); }}>
      {p.intro && <p>{p.intro}</p>}
      <Field label="Your password" id="tf-password" type="password" value={pw} onInput={setPw} autocomplete="current-password" autofocus />
      {p.second && <Field label="Code from your app, or a recovery code" id="tf-code" value={code} onInput={setCode} autocomplete="one-time-code" required={!p.passkey} />}
      <ErrorLine text={error} />
      <div class="row">
        <Submit busy={busy} label={p.submit} busyLabel="Checking…" danger={p.danger} />
        {p.second && p.passkey && <button type="button" class="btn secondary" disabled={busy || !pw} onClick={withPasskey}>{p.submit} with a passkey</button>}
        <button type="button" class="btn secondary" onClick={p.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Adding a passkey: a name, the password (and the second step while two-step sign-in is on), then the browser makes it. */
function AddPasskey(p: { second: boolean; passkey: boolean; onDone: (codes: string[] | null) => void; onCancel: () => void }) {
  const [name, setName] = useState(pk.suggestName(navigator.userAgent));
  const [options, setOptions] = useState<Record<string, any> | null>(null);
  const { busy, error, run } = useAction();
  if (!options) {
    return (
      <>
        <p>A passkey lives in your password manager, your phone or computer, or on a security key. When you sign in on a new device, you confirm it instead of typing a code. Your password is still needed.</p>
        <Field label="Name" id="pk-name" value={name} onInput={setName} hint="To tell your passkeys apart, like the password manager or key it's in." />
        <ProofForm intro="" submit="Continue" second={p.second} passkey={p.passkey} onSubmit={async (pr) => setOptions(await pk.beginAdd(pr))} onCancel={p.onCancel} />
      </>
    );
  }
  // the browser's dialog right on this tap: some browsers allow it only then
  return (
    <>
      <p>Now your browser or password manager makes the passkey.</p>
      <ErrorLine text={error} />
      <div class="row">
        <button class="btn" disabled={busy} onClick={() => run(async () => p.onDone(await pk.finishAdd(options, name)))}>{busy ? "Waiting…" : "Make the passkey"}</button>
        <button class="btn secondary" onClick={p.onCancel}>Cancel</button>
      </div>
    </>
  );
}

function RenamePasskey(p: { k: pk.Passkey; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(p.k.name);
  const { busy, error, run } = useAction();
  return (
    <form onSubmit={(e) => { e.preventDefault(); run(async () => { await pk.rename(p.k.id, name); p.onDone(); }); }}>
      <Field label="Name" id="pk-rename" value={name} onInput={setName} autofocus />
      <ErrorLine text={error} />
      <div class="row">
        <Submit busy={busy} label="Save" busyLabel="Saving…" />
        <button type="button" class="btn secondary" onClick={p.onCancel}>Cancel</button>
      </div>
    </form>
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
function DevicesPanel({ open }: { open?: boolean }) {
  const [list, setList] = useState<Device[] | null>(null);
  const [ask, setAsk] = useState<Device | "others" | null>(null);
  const { busy, error, run } = useAction();
  const load = () => api<{ sessions: Device[] }>("GET", "/api/me/sessions").then((r) => setList(r.sessions), () => setList([]));
  useEffect(() => { load(); }, []);
  const others = list?.filter((d) => !d.current).length ?? 0;
  return (
    <Acc icon="shield" title="Devices" sub="Where you're signed in" open={open}>
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
      <BrowserAlerts />
      <ErrorLine text={error} />
    </Acc>
  );
}

/** Notices as this browser's notifications while the tab is hidden (noticeAlerts.ts): off unless turned on here. */
function BrowserAlerts() {
  const on = useBrowserAlerts();
  const [refused, setRefused] = useState(false);
  if (!on && !browserAlertsPossible()) return <p class="hint">This browser doesn't allow notifications from Cipherfilm. The banner still shows a new sign-in when you come back.</p>;
  return (
    <>
      <label class="check"><input type="checkbox" checked={on} onChange={async (e) => {
        const want = (e.target as HTMLInputElement).checked;
        setRefused(want && !(await setBrowserAlerts(want))); // the browser's own question, on this click
        if (!want) await setBrowserAlerts(false);
      }} /> Notify me in this browser about a new sign-in while this tab is in the background</label>
      <p class="hint">{refused ? "The browser didn't allow notifications." : "Only while this tab is open. The notification's title says only “New sign-in to Cipherfilm”; the text names the device and the time, as the banner does."}</p>
    </>
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
  // the search model from Hugging Face: asked before it is downloaded, shown when it is here (search/consent.ts)
  useModelConsent();
  const [adopted, setAdopted] = useState(false);
  useEffect(() => { adoptCached().then(() => setAdopted(true)); }, []);
  const [ask, setAsk] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const model = useAction();
  const got = downloaded();
  const agreed = modelsAgreed(family);
  const yes = () => model.run(async () => {
    agreeModels(family);
    setAsk(false);
    setLoading("Downloading the search model…");
    try { await loadModel(family, (done, total) => setLoading(`Downloading the search model: ${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB…`)); } finally { setLoading(null); }
  });
  const off = () => model.run(async () => { await forgetContentModels(); setAsk(false); });
  return (
    <Acc icon="search" title="Search" sub="Find photos by what is in them">
      {!indexChecked() ? <Loading inline label="Checking…" /> : n === 0 && other === 0 ? (
        <p>To find photos by what's in them (dog, beach, birthday), <strong>turn on search in the Android or Mac app</strong> (Search and people). This browser then uses what the app found.</p>
      ) : (
        <p>{n === 1 ? "1 photo" : `${n} photos`} can be found by what is in them. Combine with a date or a name, like “beach 2023” or “Anna cake”.{n === 0 && " Your Android or Mac app is still indexing them with the model you chose."} Runs in this browser; your search words never leave it. Needs a {mb(TEXT_MODELS[family].size + TOKENIZER.size)} model, downloaded once from Hugging Face after you agree.</p>
      )}
      {adopted && (got || (indexChecked() && n + other > 0)) && (
        got ? (
          <>
            <p class="hint">{got.at ? `Search model downloaded from Hugging Face on ${new Date(got.at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${mb(got.bytes)}.` : `Search model downloaded from Hugging Face, ${mb(got.bytes)}.`} Hugging Face saw this device's IP address, nothing of your photos.</p>
            {loading ? <Loading inline label={loading} /> : agreed ? (
              <button class="btn secondary" disabled={model.busy} onClick={off}>Turn off and delete the model</button>
            ) : <button class="btn" disabled={model.busy} onClick={() => setAsk(true)}>Download the model…</button>}
          </>
        ) : loading ? <Loading inline label={loading} /> : !ask && (
          <button class="btn" disabled={model.busy} onClick={() => setAsk(true)}>Turn on search in this browser…</button>
        )
      )}
      {ask && <ModelConsent family={family} busy={model.busy} onYes={yes} onLater={() => setAsk(false)} />}
      <ErrorLine text={model.error} />
      {indexChecked() && n + other > 0 && <p class="hint">Hugging Face is a trademark of Hugging Face, Inc. Cipherfilm is not affiliated with or endorsed by Hugging Face.</p>}
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
          <p class="hint">Uses a model that also knows explicit content. <strong>This applies to all your devices:</strong> the indexing device (Account › Devices) indexes your whole library again, and search finds fewer photos until it's done. In this browser it's a {Math.round(TEXT_MODELS.laionb32.size / 1e6)} MB download from Hugging Face, asked first and removed when you sign out.</p>
          <ErrorLine text={error} />
        </>
      )}
    </Acc>
  );
}

function Acc(p: { icon: IconName; title: string; sub: string; children: any; open?: boolean }) {
  // opened (and shown) when a notice led here ("Review devices")
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (p.open) ref.current?.scrollIntoView({ block: "start" }); }, [p.open]);
  return (
    <details class="acc" ref={ref} open={p.open || undefined}>
      <summary>
        <span class="accicon"><Icon name={p.icon} size={22} /></span>
        <span class="acctext"><strong>{p.title}</strong><span>{p.sub}</span></span>
        <span class="chev"><Icon name="chevdown" /></span>
      </summary>
      <div class="accbody">{p.children}</div>
    </details>
  );
}

interface AdminUser { id: string; email: string; role: string; status: string; created_at: number; last_login_at: number; quota_bytes: number; used_bytes: number; item_count: number; nsfw: boolean; two_factor?: boolean }


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
    case "two-step sign-in turned off": return { icon: "key", text: <>{who} turned off two-step sign-in for {t}</>, warn: true };
    case "turned on two-step sign-in": return { icon: "key", text: <>{who} turned on two-step sign-in</> };
    case "turned off two-step sign-in": return { icon: "key", text: <>{who} turned off two-step sign-in</> };
    case "made new recovery codes": return { icon: "key", text: <>{who} made new recovery codes for two-step sign-in</> };
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
  const [confirm2fa, setConfirm2fa] = useState<string | null>(null);
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
                <span class="pmeta"><span class={"pill " + u.role}>{u.role}</span><span class={"pill " + u.status}>{u.status}</span>{u.nsfw && <span class="pill">explicit search</span>}{u.two_factor && <span class="pill">two-step sign-in</span>}<span class="small">{ago(u.last_login_at)}</span></span>
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
                {/* for someone who lost their phone and their recovery codes; they're told on their devices */}
                {u.id !== me && u.two_factor && confirm !== u.id && (confirm2fa === u.id ? (
                  <>
                    <span class="small">Turn off two-step sign-in for {u.email}? Their password alone signs in until they turn it on again. Do this only when you're sure it's them asking.</span>
                    <button class="btn danger small" onClick={() => act(async () => { await api("DELETE", `/api/admin/users/${u.id}/2fa`); setConfirm2fa(null); })}>Turn off</button>
                    <KeepButton label="Cancel" onClick={() => setConfirm2fa(null)} />
                  </>
                ) : (
                  <button class="btn secondary small" onClick={() => { setConfirm(null); setConfirm2fa(u.id); }}><Icon name="key" size={18} />Turn off two-step sign-in…<span class="sr"> for {u.email}</span></button>
                ))}
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
                      <button class="btn secondary small warn" onClick={() => { setConfirm2fa(null); setConfirm(u.id); }}><Icon name="trash" size={18} />Delete…</button>
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

/** /passkey: the Mac app's passkey step. A Mac app can't use passkeys of any server's name (Apple ties that to names
 *  fixed when the app is built), so it opens this page on the server's own address in a sign-in window; the browser
 *  asks for the passkey here and the answer goes back to the waiting app (docs/THREAT_MODEL.md, "Passkeys"). */
export function PasskeyHandoff() {
  const [h] = useState(() => { const x = pk.readHandoff(location.hash); history.replaceState(null, "", "/passkey"); return x; });
  const { busy, error, run } = useAction();
  const rp = h ? (h.op === "get" ? h.options.rpId : h.options.rp?.id) : "";
  if (!h || (rp && rp !== location.hostname)) {
    return <Card title="Passkey"><p>The Cipherfilm app on your Mac opens this page when it needs a passkey. There's nothing to do here.</p></Card>;
  }
  const back = (answer: Record<string, any> | null, why = "") => { location.href = pk.handoffReturn(answer, why); };
  return (
    <Card title={h.op === "get" ? "Confirm your sign-in" : "Make a passkey"} sealed>
      <p class="lead">The Cipherfilm app on your Mac asked for this. Continue only if you just started it there.</p>
      <p class="small">{location.host}</p>
      <ErrorLine text={error} />
      <div class="row">
        <button class="btn" disabled={busy} onClick={() => run(async () => back(h.op === "get" ? await pk.getPasskey(h.options) : await pk.createPasskey(h.options)))}>
          {busy ? "Waiting…" : h.op === "get" ? "Use your passkey" : "Make the passkey"}
        </button>
        <button class="btn secondary" onClick={() => back(null, "cancelled")}>Cancel</button>
      </div>
    </Card>
  );
}
