import { useEffect, useRef } from "preact/hooks";
import { Icon } from "./icons";
import { reportUrl, summary, thisBrowser } from "./report";

/** Asks before going to GitHub, and shows exactly what the link fills in, so nothing leaves without the person seeing
 *  it. "Without details" opens the empty form. */
export function ReportDialog({ serverVersion, onClose }: { serverVersion?: string; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const details = thisBrowser(serverVersion);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dlg.current!.showModal();
    return () => setTimeout(() => (opener?.isConnected ? opener : document.querySelector<HTMLElement>(".avatarbtn"))?.focus());
  }, []);
  // a new tab, so the library stays open (and unlocked) here; noopener: github.com gets no handle on this page
  const go = (withDetails: boolean) => { window.open(reportUrl(withDetails ? details : undefined), "_blank", "noopener,noreferrer"); onClose(); };
  return (
    <dialog ref={dlg} class="helpdlg reportdlg" aria-labelledby="report-title" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === dlg.current) onClose(); }}>
      <div class="helphead"><h2 id="report-title"><Icon name="info" />Report a problem</h2><button class="iconbtn" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
      <p>You'll continue in the browser, on the project's issue tracker (posting needs a free account there). We'll fill in this device's details:</p>
      <p class="reportline"><strong>{summary(details)}</strong></p>
      <p class="small">Nothing else is sent: no server address, e-mail, photos or names.</p>
      <div class="row">
        <button class="btn" autofocus onClick={() => go(true)}>Include details</button>
        <button class="btn secondary" onClick={() => go(false)}>Without details</button>
        <button class="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </dialog>
  );
}
