// The notices (notices.ts) under a bell in the top bar, next to the account button: a count of the unread ones on the
// bell, and a panel that lists every notice with what it implies ("Review devices") and a way to remove it (dismissed
// on every device). Unread are the ones newer than the newest this browser already showed in the open panel
// (notices.ts readUpTo); opening the panel marks them read. Escape or a click outside closes it.
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons";
import { markRead, newestId, noticeAction, noticeText, readUpTo, unreadCount, type Notice } from "./notices";

export function NoticesButton(p: {
  /** the signed-in account's id: what was read is remembered per account */
  account: string;
  notices: Notice[];
  /** the notice's link: opens the part of Account it names */
  onAct: (n: Notice) => void;
  onRemove: (n: Notice) => void;
  onRemoveAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [upTo, setUpTo] = useState(() => readUpTo(p.account));
  // what counted as read when the panel opened: the ones after it are marked new in the list
  const [before, setBefore] = useState(upTo);
  const btn = useRef<HTMLButtonElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const unread = unreadCount(p.notices, upTo);

  // shown in the open panel = read (also the ones that arrive while it is open)
  useEffect(() => {
    if (!open) return;
    const newest = newestId(p.notices);
    if (newest > upTo) { markRead(p.account, newest); setUpTo(newest); }
  }, [open, p.notices]);
  // another tab of the same browser read them
  useEffect(() => {
    const f = () => setUpTo((u) => Math.max(u, readUpTo(p.account)));
    window.addEventListener("storage", f);
    return () => window.removeEventListener("storage", f);
  }, [p.account]);

  const close = (focus: boolean) => { setOpen(false); if (focus) btn.current?.focus(); };
  const toggle = () => {
    if (open) { close(false); return; }
    setBefore(upTo);
    setOpen(true);
    requestAnimationFrame(() => head.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => { if (!(e.target as Element | null)?.closest?.(".bellwrap")) setOpen(false); };
    // before the library's own keys (on window), which would also end select mode
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(true); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", esc); };
  }, [open]);

  const remove = (n: Notice) => { p.onRemove(n); head.current?.focus(); };
  const label = unread === 0 ? "Notifications" : `Notifications, ${unread} unread`;
  return (
    <div class="bellwrap">
      <button ref={btn} class="iconbtn bellbtn" aria-label={label} title="Notifications" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "notices-panel" : undefined} onClick={toggle}>
        <Icon name="bell" size={22} />
        {unread > 0 && <span class="bellbadge" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {/* says so when one arrives, without moving the focus */}
      <span class="sr" role="status">{unread > 0 && !open ? `${unread} unread ${unread === 1 ? "notification" : "notifications"}` : ""}</span>
      {open && (
        <div class="menu noticepanel" id="notices-panel" role="dialog" aria-labelledby="notices-h">
          <div class="noticehead">
            <h2 id="notices-h" ref={head} tabIndex={-1}>Notifications</h2>
            {p.notices.length > 0 && <button class="link small" onClick={() => { p.onRemoveAll(); head.current?.focus(); }}>Remove all</button>}
          </div>
          {p.notices.length === 0 ? (
            <p class="small noticeempty">Nothing new. A sign-in on another device or a change to two-step sign-in shows up here.</p>
          ) : (
            <ul class="noticelist">
              {p.notices.map((n) => {
                const act = noticeAction(n);
                const fresh = n.id > before;
                return (
                  <li key={n.id} class={fresh ? "fresh" : undefined}>
                    <Icon name={n.kind === "sign_in" ? "shield" : "key"} size={20} />
                    <div class="noticebody">
                      <p>{fresh && <span class="sr">New: </span>}{noticeText(n)}</p>
                      <button class="link" onClick={() => { close(false); p.onAct(n); }}>{act.label}</button>
                    </div>
                    <button class="iconbtn tiny" aria-label={`Remove: ${noticeText(n)}`} title="Remove" onClick={() => remove(n)}><Icon name="x" size={16} /></button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
