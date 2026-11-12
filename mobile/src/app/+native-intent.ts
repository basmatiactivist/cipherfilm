import { isNoticeLink, openFromNotice } from "../noticeOpen";
import { isPasskeyReturn, passkeyReturned } from "../passkeyHandoff";

// Android opens the app with a link when someone shares photos to it: send that to the upload screen. A tap on a
// notice's notification: to the start, which unlocks first if needed; the root layout then opens Devices.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    // the /passkey page's answer (passkeyHandoff.ts): to the waiting sign-in, no navigation
    if (isPasskeyReturn(path)) { passkeyReturned(path); return ""; }
    if (new URL(path).hostname === "expo-sharing") return "/share";
    if (isNoticeLink(path)) { openFromNotice(); return "/"; }
    return path;
  } catch {
    return "/";
  }
}
