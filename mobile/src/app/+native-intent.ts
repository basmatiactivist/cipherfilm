// Android opens the app with a link when someone shares photos to it: send that to the upload screen.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (new URL(path).hostname === "expo-sharing") return "/share";
    return path;
  } catch {
    return "/";
  }
}
