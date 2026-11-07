import { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { paint } from "./auth";
import { Loader } from "./loader";

export const MIN_PASSWORD = 10;

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    await paint();
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

export function Field(p: {
  label: string; id: string; type?: string; value: string; onInput: (v: string) => void;
  autocomplete?: string; hint?: string; readOnly?: boolean; required?: boolean; autofocus?: boolean; minLength?: number;
}) {
  // the autofocus attribute only works on page load; a field that appears later (rename, a step of a form) is focused here
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (p.autofocus) { ref.current?.focus(); ref.current?.select(); } }, []);
  return (
    <div class="field">
      <label for={p.id}>{p.label}</label>
      <input
        ref={ref} id={p.id} name={p.id} type={(p.type ?? "text") as "text"} value={p.value} required={p.required ?? true}
        autocomplete={p.autocomplete} readOnly={p.readOnly} autofocus={p.autofocus} minLength={p.minLength}
        aria-describedby={p.hint ? p.id + "-hint" : undefined}
        onInput={(e) => p.onInput((e.target as HTMLInputElement).value)}
        autocapitalize="none" spellcheck={false}
      />
      {p.hint && <p class="hint" id={p.id + "-hint"}>{p.hint}</p>}
    </div>
  );
}

export function NewPasswordFields(p: { pw: string; setPw: (v: string) => void; pw2: string; setPw2: (v: string) => void; label?: string }) {
  return (
    <>
      <Field label={p.label ?? "Password"} id="new-password" type="password" value={p.pw} onInput={p.setPw}
        autocomplete="new-password" hint={`At least ${MIN_PASSWORD} characters. A few random words is a good choice.`} />
      <Field label={p.label ? `Repeat ${p.label.toLowerCase()}` : "Repeat password"} id="new-password2" type="password" value={p.pw2} onInput={p.setPw2} autocomplete="new-password" />
    </>
  );
}

/** Returns a message when the two passwords are not acceptable, else "". */
export function passwordProblem(pw: string, pw2: string): string {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw !== pw2) return "The two passwords don't match.";
  return "";
}

export function Card(p: { title: string; sealed?: boolean; children: ComponentChildren; wide?: boolean }) {
  return (
    <section class={"card" + (p.sealed ? " sealed" : "") + (p.wide ? " wide" : "")} aria-labelledby="card-title">
      <h1 id="card-title">{p.title}</h1>
      {p.children}
    </section>
  );
}

/** "Cipherfilm web 1.2.3 · server 1.2.3"; the server part only once it is known. */
export function VersionLine({ server }: { server?: string }) {
  return <p class="small version">Cipherfilm web {__APP_VERSION__}{server ? ` · server ${server}` : ""}</p>;
}

export function ErrorLine({ text }: { text: string }) {
  return text ? <p class="error" role="alert">{text}</p> : null;
}

export function Submit(p: { busy: boolean; label: string; busyLabel: string; danger?: boolean }) {
  return (
    <button type="submit" class={"btn" + (p.danger ? " danger" : "")} disabled={p.busy} aria-busy={p.busy}>
      {p.busy ? <><Loader />{p.busyLabel}</> : p.label}
    </button>
  );
}

/** The safe button of a confirmation that just appeared ("Keep"): it takes the focus, so keyboard and screen reader
 *  users land in the question instead of on the page body, and Enter does no harm. */
export function KeepButton(p: { label: string; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { ref.current?.focus(); }, []);
  return <button ref={ref} class="btn secondary small" onClick={p.onClick}>{p.label}</button>;
}

export const fmtGB = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(0) + " MB" : n > 0 ? "less than 1 MB" : "0 MB");
