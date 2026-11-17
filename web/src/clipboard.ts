// Copying a secret (the recovery key, recovery codes, the setup key, an invite link): it is taken off the clipboard
// again after a minute, as the Android and Mac apps do. A page can do that only while it has the focus, so if the
// person is elsewhere at that moment, it happens when they come back to the tab. It is left alone when something else
// was copied since: on this page that is seen directly, elsewhere only where the browser already lets this page read
// the clipboard. Copies a clipboard history or sync already took are out of reach.

export const CLEAR_AFTER = 60_000;

let armed: { text: string; cancel: () => void } | undefined;

/** Copies text, and arranges for it to be cleared from the clipboard after CLEAR_AFTER. Rejects as writeText does. */
export async function copySecret(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  armed?.cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCopy = () => disarm(); // the person copied something else on this page: theirs stays
  const onFocus = () => { if (document.hasFocus()) attempt(); };
  const disarm = () => {
    clearTimeout(timer);
    document.removeEventListener("copy", onCopy);
    document.removeEventListener("cut", onCopy);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
    if (armed === me) armed = undefined;
  };
  const attempt = async () => {
    if (armed !== me) return;
    if (!document.hasFocus()) { // wait for the person to come back
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onFocus);
      return;
    }
    disarm();
    if (!(await stillThere(text))) return;
    try { await navigator.clipboard.writeText(""); } catch { /* the browser refused: nothing more a page can do */ }
  };
  const me = { text, cancel: disarm };
  armed = me;
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCopy);
  timer = setTimeout(attempt, CLEAR_AFTER);
}

/** False only when the clipboard can be read without asking and holds something else. */
async function stillThere(text: string): Promise<boolean> {
  try {
    const p = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
    if (p?.state !== "granted") return true;
    return (await navigator.clipboard.readText()) === text;
  } catch {
    return true;
  }
}

/** Whether a clear is still to come (for the tests). */
export const pendingClear = () => !!armed;
