import { useState } from "preact/hooks";
import { passwordProof } from "./auth";
import { Field, Submit, useAction } from "./components";
import { Icon } from "./icons";
import { mem } from "./state";

/**
 * The locked folder's check (docs/EDITING.md, "Archive and locked folder"): the account password, every time the folder
 * opens, also while the library is unlocked. It is checked here, in this browser, the way unlocking does (the key
 * derived from it must open the master key); nothing is sent. A gate in the app, not a second key: the items'
 * metadata is decrypted with the library, the check only decides what is shown.
 */
export function LockedGate(p: { onOpen: () => void }) {
  const [pw, setPw] = useState("");
  const { busy, error, run } = useAction();
  return (
    <section class="panel lockedgate">
      <span class="emptyicon"><Icon name="lock" size={32} /></span>
      <h2>Locked folder</h2>
      <p>Photos and videos here show nowhere else in Cipherfilm. Enter your password to open the folder; it closes again when you leave it.</p>
      <form onSubmit={(e) => { e.preventDefault(); run(async () => { await passwordProof(pw); setPw(""); p.onOpen(); }); }}>
        <input type="text" name="username" value={mem.me!.user.email} autocomplete="username" hidden readOnly />
        <Field label="Password" id="locked-password" type="password" value={pw} onInput={setPw} autocomplete="current-password" autofocus />
        {error && <p class="error" role="alert">{error}</p>}
        <Submit busy={busy} label="Open locked folder" busyLabel="Checking…" />
      </form>
    </section>
  );
}
