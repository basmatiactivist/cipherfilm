// Files waiting for the upload screen. Picked files (Upload button) wait here; shared ones in expo-sharing. Both belong
// to the account that was there when they arrived: a sign-out, session end or server change drops them, so they are
// never uploaded into whoever signs in next.
import { clearSharedPayloads } from "expo-sharing";
import { onWipe } from "./session";

let picked: string[] = [];
export const setPicked = (uris: string[]) => { picked = uris; };
export const takePicked = (): string[] => { const p = picked; picked = []; return p; };

onWipe((how) => {
  if (how !== "ended") return; // a lock keeps them: the share continues after unlocking
  picked = [];
  try { clearSharedPayloads(); } catch { /* nothing pending */ }
});
