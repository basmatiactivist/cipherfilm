import { useEffect } from "react";
import { AppState, StatusBar, useColorScheme } from "react-native";
import { Stack, router, useSegments } from "expo-router";
import { PaperProvider } from "react-native-paper";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SystemUI from "expo-system-ui";
import { Image } from "expo-image";
import { dark, light, paperTheme } from "../theme";
import { Icon, type IconName } from "../icons";
import { onWipe, start, useSession } from "../session";
import { clearOutbox, tidyOutbox } from "../outbox";
import { runBackup, scheduleBackground } from "../backup";
import { startShake } from "../shake";
import { startAutoLock } from "../autolock";
import { liveUnlocked } from "../live";
import { startLiveSync } from "../liveSync";
import { refreshLang, useLang } from "../i18n";

// expo-image keeps decoded pictures (the viewer's previews, faces) in its memory cache beyond the
// session that decrypted them: dropped at every lock and sign-out, and once more after the screens that showed them
// have closed (a picture goes into that cache when its view goes away). Never on disk: those use cachePolicy "memory".
onWipe(() => {
  const drop = () => { Image.clearMemoryCache().catch(() => {}); };
  drop();
  setTimeout(drop, 1500);
});

const themes = { light: paperTheme(light, false), dark: paperTheme(dark, true) };
// screens that show the library: none stays on screen while it is locked
const PRIVATE = new Set(["library", "albums", "album", "photo", "account", "trash", "backup", "search", "people", "person", "favorites", "free-space", "search-settings", "map"]);

export default function Root() {
  const theme = useColorScheme() === "dark" ? themes.dark : themes.light;
  useEffect(() => { SystemUI.setBackgroundColorAsync(theme.colors.background); }, [theme]);
  useEffect(() => { clearOutbox(); start(); startShake(); startAutoLock(); startLiveSync(); scheduleBackground().catch(() => {}); runBackup("app").catch(() => {}); }, []);
  useEffect(() => {
    // a language changed in Android's settings meanwhile (the phone's or the app's own) applies at once (below)
    refreshLang();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") { refreshLang(); tidyOutbox(); runBackup("app").catch(() => {}); } });
    return () => sub.remove();
  }, []);
  // nothing that shows the library stays on screen once it is locked or signed out
  const { phase } = useSession();
  // what other devices change shows here while the app is on screen and unlocked (live.ts)
  useEffect(() => { liveUnlocked(phase === "unlocked"); }, [phase]);
  const segments = useSegments();
  // A new language renders every screen again: they read their words with t() while rendering, and the navigator
  // keeps its screens from rendering again on their own. Keyed by the language, the navigator mounts anew and takes
  // up the navigation state it had (the same screens, in the same order, with their parameters); what a screen held
  // only in itself (a scroll position, a half-typed name) starts over.
  const lang = useLang();
  useEffect(() => {
    const top = segments[0] as string | undefined;
    if (phase !== "unlocked" && phase !== "starting" && PRIVATE.has(top ?? "")) router.replace("/");
  }, [phase, segments]);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={theme.dark ? "light-content" : "dark-content"} />
      <PaperProvider theme={theme} settings={{ icon: ({ name, color, size }) => <Icon name={name as string} color={color ?? theme.colors.onSurface} size={size} /> }}>
        <Stack key={lang} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background }, animation: "fade_from_bottom" }}>
          {/* the two places in the navigation bar switch without an animation, as tabs do */}
          <Stack.Screen name="library" options={{ animation: "none" }} />
          <Stack.Screen name="albums" options={{ animation: "none" }} />
          <Stack.Screen name="search" options={{ animation: "none" }} />
        </Stack>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
