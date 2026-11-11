import { isNoticeLink, openFromNotice } from "../noticeOpen";

// Android opens the app with a link when someone shares photos to it: send that to the upload screen. A tap on a
// notice's notification: to the start, which unlocks first if needed; the root layout then opens Devices.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (new URL(path).hostname === "expo-sharing") return "/share";
    if (isNoticeLink(path)) { openFromNotice(); return "/"; }
    return path;
  } catch {
    return "/";
  }
}
