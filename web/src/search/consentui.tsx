// The question before the search model is downloaded from Hugging Face (consent.ts), in the look and words of the
// map's (map/ui.tsx MapConsent): what, from whom, what they learn, and the two buttons.
import { Icon } from "../icons";
import type { Family } from "./rank";
import { bytesOf, filesFor, mb, MODELS_PRIVACY_URL } from "./consent";
import { useModelDownload } from "./content";

export function ModelConsent(p: { family: Family; onYes: () => void; onLater: () => void; busy?: boolean }) {
  return (
    <section class="panel mapconsent" aria-labelledby="modelconsent-h">
      <span class="accicon"><Icon name="search" size={22} /></span>
      <h2 id="modelconsent-h">Download the search model?</h2>
      <p>To find photos by what is in them, this browser needs the text part of the search model and its word list, {mb(bytesOf(filesFor(p.family)))} in all. They are downloaded once for this device from the public site where these open models are published (which one: see the privacy policy). Each file is checked (SHA-256) before it is used.</p>
      <p>That site sees this device's IP address and that it downloaded these public files. It gets no photos, faces, search words or account data.</p>
      <p class="small"><a href={MODELS_PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy policy</a> · You can turn this off and delete the model under Account › Search.</p>
      <div class="row">
        <button class="btn" disabled={p.busy} onClick={p.onYes}>Download and turn on</button>
        <button class="btn secondary" onClick={p.onLater}>Not now</button>
      </div>
    </section>
  );
}

/** The search model's download as it goes (content.ts useModelDownload), wherever it was started: a bar with how many
 *  MB of how many, then "ready" once, or what went wrong with a button to try again. */
export function ModelProgress(p: { onRetry?: () => void; showReady?: boolean }) {
  const d = useModelDownload();
  if (d.phase === "downloading") {
    const pct = d.total ? Math.floor((d.done / d.total) * 100) : 0;
    return (
      <div class="modelprog" role="status" aria-live="polite">
        <p class="small">Downloading the search model: {Math.round(d.done / 1e6)} of {Math.round(d.total / 1e6)} MB ({pct}%). You can keep using Cipherfilm meanwhile.</p>
        <progress max={d.total || 1} value={d.done} aria-label={`Search model download, ${pct}%`} />
      </div>
    );
  }
  if (d.phase === "error") {
    return (
      <div class="modelprog" role="alert">
        <p class="small error">The search model couldn't be downloaded: {d.error ?? "unknown error"}</p>
        {p.onRetry && <button class="btn secondary small" onClick={p.onRetry}>Try again</button>}
      </div>
    );
  }
  if (d.phase === "ready" && p.showReady) return <p class="small" role="status">Search model downloaded. Search by what is in your photos is on.</p>;
  return null;
}
