import { useEffect, useState } from "preact/hooks";
import * as auth from "./auth";
import { mem } from "./state";
import { Card, ErrorLine, Field, Submit, VersionLine, useAction } from "./components";
import { passkeysSupported } from "./passkeys";

// The two screens a returning visitor may see first; everything else in screens.tsx loads when it's needed.
type Nav = (to: string) => void;

export function Login({ nav, onDone, notice }: { nav: Nav; onDone: () => void; notice?: string }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [step, setStep] = useState<auth.CodeStep | null>(null);
  const { busy, error, setError, run } = useAction();
  const signIn = async (e: string, p: string) => {
    const s = await auth.login(e, p);
    if (!s) return onDone();
    setPw(""); // the step holds what it needs; the password isn't kept on screen meanwhile
    setStep(s);
  };
  if (step) {
    return <CodeForm step={step} onDone={onDone} onRestart={(why) => { step.cancel(); setStep(null); setError(why); }} />;
  }
  // the demo login comes with the server's status, which a sign-in screen reached by signing out hasn't asked for
  const [, shown] = useState(false);
  useEffect(() => { if (!auth.demoLogin) auth.needsSetup().then(() => shown(true), () => {}); }, []);
  return (
    <Card title="Sign in" sealed>
      {notice && <p class="note" role="status">{notice}</p>}
      <p class="privacy lead">Your photos are encrypted in your browser. Only you can open them.</p>
      {auth.demoLogin && (
        <div class="demologin" role="note">
          <p><strong>Public demo.</strong> Sign in with <code>{auth.demoLogin.email}</code> and <code>{auth.demoLogin.password}</code>. Read-only, sample photos.</p>
          <button type="button" class="btn" disabled={busy} onClick={() => { const d = auth.demoLogin!; setEmail(d.email); setPw(d.password); run(() => signIn(d.email, d.password)); }}>Open the demo</button>
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); run(() => signIn(email, pw)); }}>
        <Field label="E-mail" id="email" type="email" value={email} onInput={setEmail} autocomplete="username" autofocus />
        <Field label="Password" id="password" type="password" value={pw} onInput={setPw} autocomplete="current-password" />
        <ErrorLine text={error} />
        <Submit busy={busy} label="Sign in" busyLabel="Signing in…" />
      </form>
      <p class="aside"><a href="/recover" onClick={(e) => { e.preventDefault(); nav("/recover"); }}>Forgot your password? Use your recovery key</a></p>
      <VersionLine server={auth.serverVersion} />
    </Card>
  );
}

export function Unlock({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const [pw, setPw] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Card title="Unlock your library" sealed>
      <p>Signed in as <strong class="email">{mem.me!.user.email}</strong>. Enter your password to unlock.</p>
      <form onSubmit={(e) => { e.preventDefault(); run(async () => { await auth.unlock(pw); onDone(); }); }}>
        <input type="text" name="username" value={mem.me!.user.email} autocomplete="username" hidden readOnly />
        <Field label="Password" id="password" type="password" value={pw} onInput={setPw} autocomplete="current-password" autofocus />
        <ErrorLine text={error} />
        <Submit busy={busy} label="Unlock" busyLabel="Unlocking…" />
      </form>
      <p class="aside"><button class="link" onClick={onSignOut}>Sign out instead</button></p>
    </Card>
  );
}

/** The second step of a sign-in with two-step sign-in on: a passkey, a code from the authenticator app, or a recovery
 *  code. */
function CodeForm({ step, onDone, onRestart }: { step: auth.CodeStep; onDone: () => void; onRestart: (why: string) => void }) {
  const canPasskey = step.passkey && passkeysSupported();
  const [how, setHow] = useState<"passkey" | "code" | "recovery">(canPasskey && !step.totp ? "passkey" : step.totp || !step.passkey ? "code" : "recovery");
  const [code, setCode] = useState("");
  const { busy, error, setError, run } = useAction();
  // leaving the screen any other way (a sign-in in another tab) drops the key the step holds; after a sign-in it's a no-op
  useEffect(() => () => step.cancel(), [step]);
  const attempt = (f: () => Promise<void>) => run(async () => {
    try {
      await f();
    } catch (err) {
      if (err instanceof auth.CodeExpired) return onRestart(err.message);
      setCode("");
      throw err;
    }
    onDone();
  });
  const usePasskey = () => attempt(() => step.usePasskey());
  useEffect(() => { if (how === "passkey" && !busy) step.preparePasskey(); }, [how, busy]);
  const switchTo = (h: typeof how) => { setHow(h); setCode(""); setError(""); };
  const others = ([["passkey", "Use a passkey"], ["code", "Use a code from your app"], ["recovery", "Use a recovery code"]] as const)
    .filter(([h]) => h !== how && (h !== "passkey" || canPasskey) && (h !== "code" || step.totp));
  return (
    <Card title="Two-step sign-in" sealed>
      {how === "passkey" ? (
        <>
          <p class="lead">Confirm with your passkey. Your browser or password manager will ask for it.</p>
          <ErrorLine text={error} />
          <button type="button" class="btn" disabled={busy} onClick={usePasskey} autofocus>{busy ? "Checking…" : "Use your passkey"}</button>
        </>
      ) : (
        <>
          <p class="lead">{how === "recovery" ? "Enter one of the recovery codes you saved when you turned on two-step sign-in. Each works once." : "Enter the 6-digit code from your authenticator app."}</p>
          <form onSubmit={(e) => { e.preventDefault(); attempt(() => step.finish(code)); }}>
            {how === "recovery" ? (
              <Field key="rc" label="Recovery code" id="recovery-code" value={code} onInput={setCode} autocomplete="off" autofocus hint="Like abcd-1234-efgh-5678. Dashes don't matter." />
            ) : (
              <Field key="otp" label="Code" id="code" value={code} onInput={setCode} autocomplete="one-time-code" inputmode="numeric" pattern="[0-9 ]*" maxLength={7} autofocus />
            )}
            <ErrorLine text={error} />
            <Submit busy={busy} label="Sign in" busyLabel="Checking…" />
          </form>
        </>
      )}
      <p class="aside">
        {others.map(([h, label]) => <span key={h}><button type="button" class="link" onClick={() => switchTo(h)}>{label}</button>{" · "}</span>)}
        <button type="button" class="link" onClick={() => onRestart("")}>Start over</button>
      </p>
      <p class="hint small">Lost your phone, your passkeys and your recovery codes? Ask your administrator to turn off two-step sign-in for your account.</p>
    </Card>
  );
}
