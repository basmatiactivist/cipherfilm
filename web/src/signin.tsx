import { useState } from "preact/hooks";
import * as auth from "./auth";
import { mem } from "./state";
import { Card, ErrorLine, Field, Submit, VersionLine, useAction } from "./components";

// The two screens a returning visitor may see first; everything else in screens.tsx loads when it's needed.
type Nav = (to: string) => void;

export function Login({ nav, onDone, notice }: { nav: Nav; onDone: () => void; notice?: string }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Card title="Sign in" sealed>
      {notice && <p class="note" role="status">{notice}</p>}
      <p class="privacy lead">Your photos are encrypted in your browser. Only you can open them.</p>
      <form onSubmit={(e) => { e.preventDefault(); run(async () => { await auth.login(email, pw); onDone(); }); }}>
        <Field label="E-mail" id="email" type="email" value={email} onInput={setEmail} autocomplete="username" autofocus />
        <Field label="Password" id="password" type="password" value={pw} onInput={setPw} autocomplete="current-password" />
        <ErrorLine text={error} />
        <Submit busy={busy} label="Sign in" busyLabel="Unlocking, this takes a second or two" />
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
      <p>You're signed in as <strong class="email">{mem.me!.user.email}</strong>. Enter your password to unlock your photos on this device.</p>
      <form onSubmit={(e) => { e.preventDefault(); run(async () => { await auth.unlock(pw); onDone(); }); }}>
        <input type="text" name="username" value={mem.me!.user.email} autocomplete="username" hidden readOnly />
        <Field label="Password" id="password" type="password" value={pw} onInput={setPw} autocomplete="current-password" autofocus />
        <ErrorLine text={error} />
        <Submit busy={busy} label="Unlock" busyLabel="Unlocking, this takes a second or two" />
      </form>
      <p class="aside"><button class="link" onClick={onSignOut}>Sign out instead</button></p>
    </Card>
  );
}
