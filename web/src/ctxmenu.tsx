import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon, IconName } from "./icons";

export interface MenuItem { label: string; icon: IconName; run?: () => void; danger?: boolean; sub?: MenuItem[] }

/** A right-click menu with the actions you want next to the thing you clicked. Arrow keys move, Enter picks, Escape closes. */
export function ContextMenu(p: { x: number; y: number; title?: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stack, setStack] = useState<MenuItem[][]>([]);
  const [pos, setPos] = useState({ left: p.x, top: p.y });
  const items = stack.length ? stack[stack.length - 1] : p.items;

  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(p.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(p.y, innerHeight - r.height - 8)) });
    el.querySelector<HTMLButtonElement>("button")?.focus();
  }, [stack.length]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => setTimeout(() => { if (!document.querySelector("dialog[open]")) (opener?.isConnected && opener !== document.body ? opener : document.getElementById("main"))?.focus(); });
  }, []);
  useEffect(() => {
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) p.onClose(); };
    const close = () => p.onClose();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, []);

  const onKey = (e: KeyboardEvent) => {
    const btns = [...ref.current!.querySelectorAll<HTMLButtonElement>("button")];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (stack.length) setStack((s) => s.slice(0, -1)); else p.onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); btns[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); btns[btns.length - 1].focus(); }
    else if (e.key === "Tab") { e.preventDefault(); p.onClose(); }
  };

  return (
    <div class="ctxmenu" role="menu" aria-label={p.title ?? "Actions"} ref={ref} style={{ left: pos.left + "px", top: pos.top + "px" }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      {stack.length > 0 && <button class="menuitem" role="menuitem" onClick={() => setStack((s) => s.slice(0, -1))}><Icon name="back" />Back</button>}
      {items.map((it) => (
        <button key={it.label} class={"menuitem" + (it.danger ? " danger" : "")} role="menuitem" onClick={() => { if (it.sub) setStack((s) => [...s, it.sub!]); else { p.onClose(); it.run?.(); } }}>
          <Icon name={it.icon} />{it.label}
        </button>
      ))}
    </div>
  );
}
