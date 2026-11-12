import { useEffect, useRef } from "preact/hooks";
import { Icon } from "./icons";

export const SHORTCUTS: { group: string; rows: [string, string][] }[] = [
  { group: "Anywhere", rows: [["?", "Show this list"], ["/", "Search"], ["U", "Upload photos and videos"], ["G then T", "Go to Timeline"], ["G then F", "Go to Favorites"], ["G then A", "Go to Albums"], ["G then P", "Go to People"], ["G then D", "Go to Trash"], ["Esc", "Close, or leave select mode"]] },
  { group: "Photos", rows: [["S", "Turn select mode on or off"], ["Ctrl or Cmd + A", "Select everything shown"], ["Shift + click", "Select a range"], ["Ctrl or Cmd + click", "Add or remove one photo"], ["Delete", "Move the selection to the trash"], ["Right-click", "Quick actions for a photo or album"]] },
  { group: "Viewing a photo", rows: [["← and →", "Previous and next"], ["F", "Add to or remove from favorites"], ["I", "Show or hide info"], ["D", "Download (an edited photo as edited)"], ["Shift D", "Download the original"], ["E", "Edit"], ["Delete", "Move to the trash"], ["Esc", "Close"]] },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dlg.current!.showModal();
    return () => setTimeout(() => (opener?.isConnected ? opener : document.querySelector<HTMLElement>(".avatarbtn"))?.focus());
  }, []);
  return (
    <dialog ref={dlg} class="helpdlg" aria-label="Keyboard shortcuts" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === dlg.current) onClose(); }}>
      <div class="helphead"><h2><Icon name="keyboard" />Keyboard shortcuts</h2><button class="iconbtn" aria-label="Close shortcuts" onClick={onClose}><Icon name="x" /></button></div>
      {SHORTCUTS.map((g) => (
        <section key={g.group}>
          <h3>{g.group}</h3>
          <dl>{g.rows.map(([k, d]) => <div key={k + d}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>)}</dl>
        </section>
      ))}
    </dialog>
  );
}
