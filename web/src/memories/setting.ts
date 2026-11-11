// Memories are on unless turned off under Account › Memories. The choice belongs to this browser (every account in
// it), like a display setting; nothing about it reaches the server.
import { useEffect, useState } from "preact/hooks";

const KEY = "cf-memories-off";
const subs = new Set<() => void>();

export function memoriesOn(): boolean {
  try { return localStorage.getItem(KEY) !== "1"; } catch { return true; }
}

export function setMemoriesOn(on: boolean) {
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, "1"); } catch { /* storage off: memories stay on */ }
  subs.forEach((f) => f());
}

/** Whether memories show, kept current when switched here or in another tab. */
export function useMemoriesOn(): boolean {
  const [on, setOn] = useState(memoriesOn);
  useEffect(() => {
    const f = () => setOn(memoriesOn());
    subs.add(f);
    window.addEventListener("storage", f);
    return () => { subs.delete(f); window.removeEventListener("storage", f); };
  }, []);
  return on;
}
