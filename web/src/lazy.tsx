import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";

export const Loading = () => <p class="boot" role="status">Loading…</p>;

/** A component whose code is fetched the first time it renders, or earlier with preload(); `fallback` shows meanwhile.
 *  The chunks come from this origin, so the CSP's script-src 'self' covers them. */
export function lazy<P extends object>(load: () => Promise<ComponentType<P>>, fallback: () => any = Loading) {
  let C: ComponentType<P> | undefined;
  let pending: Promise<void> | undefined;
  // a failed fetch (offline, or a new release removed the old chunk) is tried again next time
  const preload = () => (pending ??= load().then((c) => { C = c; }, (e) => { pending = undefined; throw e; }));
  function Lazy(props: P) {
    const [, loaded] = useState(false);
    const [failed, setFailed] = useState(false);
    useEffect(() => { if (!C) preload().then(() => loaded(true), () => setFailed(true)); }, []);
    if (C) return <C {...props} />;
    return failed ? <p class="boot" role="alert">Couldn't load this part of Cipherfilm. Check your connection and reload the page.</p> : fallback();
  }
  return Object.assign(Lazy, { preload });
}
