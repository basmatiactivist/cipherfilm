// The question before the search model is downloaded from Hugging Face (consent.ts), in the look and words of the
// map's (map/ui.tsx MapConsent): what, from whom, what they learn, and the two buttons.
import { Icon } from "../icons";
import type { Family } from "./rank";
import { bytesOf, filesFor, mb, MODELS_PRIVACY_URL } from "./consent";

export function ModelConsent(p: { family: Family; onYes: () => void; onLater: () => void; busy?: boolean }) {
  return (
    <section class="panel mapconsent" aria-labelledby="modelconsent-h">
      <span class="accicon"><Icon name="search" size={22} /></span>
      <h2 id="modelconsent-h">Download the search model?</h2>
      <p>To find photos by what is in them, this browser needs the text part of the search model and its word list, {mb(bytesOf(filesFor(p.family)))} in all. They are downloaded once for this device from Hugging Face (huggingface.co and its CDN, *.hf.co), where these open models are published. Each file is checked (SHA-256) before it is used.</p>
      <p>Hugging Face sees this device's IP address and that it downloaded these public files. It gets no photos, faces, search words or account data.</p>
      <p class="small"><a href={MODELS_PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy policy</a> · You can turn this off and delete the model under Account › Search.</p>
      <div class="row">
        <button class="btn" disabled={p.busy} onClick={p.onYes}>Download and turn on</button>
        <button class="btn secondary" onClick={p.onLater}>Not now</button>
      </div>
    </section>
  );
}
