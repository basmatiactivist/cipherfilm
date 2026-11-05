import { useEffect } from "react";
import { AppState, StatusBar, useColorScheme } from "react-native";
import { Stack, router, useSegments } from "expo-router";
import N from "../../modules/cf-native/src/CfNativeModule";
import { PaperProvider } from "react-native-paper";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SystemUI from "expo-system-ui";
import { dark, light, paperTheme } from "../theme";
import { Icon, type IconName } from "../icons";
import { lock, session, start, useSession } from "../session";
import { uploadsRunning } from "../upload";
import { clearOutbox, tidyOutbox } from "../outbox";
import { runBackup, scheduleBackground } from "../backup";
import { startShake } from "../shake";

const themes = { light: paperTheme(light, false), dark: paperTheme(dark, true) };
// screens that show the library: none stays on screen while it is locked
const PRIVATE = new Set(["library", "albums", "album", "photo", "account", "trash", "backup", "search", "people", "person", "favorites", "free-space", "search-settings"]);
const LOCK_AFTER = 5 * 60 * 1000; // in the background longer than this: the key leaves memory

export default function Root() {
  const theme = useColorScheme() === "dark" ? themes.dark : themes.light;
  useEffect(() => { SystemUI.setBackgroundColorAsync(theme.colors.background); }, [theme]);
  useEffect(() => { clearOutbox(); start(); startShake(); scheduleBackground().catch(() => {}); runBackup("app").catch(() => {}); }, []);
  useEffect(() => {
    // time away is measured on the monotonic clock (counts deep sleep, can't be set back like the wall clock)
    let away = -1;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") { tidyOutbox(); runBackup("app").catch(() => {}); }
      if (s === "background") away = N.elapsedRealtime();
      else if (s === "active" && away >= 0) {
        const gone = N.elapsedRealtime() - away;
        away = -1;
        if ((gone < 0 || gone > LOCK_AFTER) && session().phase === "unlocked" && uploadsRunning() === 0) lock();
      }
    });
    return () => sub.remove();
  }, []);
  // nothing that shows the library stays on screen once it is locked or signed out
  const { phase } = useSession();
  const segments = useSegments();
  useEffect(() => {
    const top = segments[0] as string | undefined;
    if (phase !== "unlocked" && phase !== "starting" && PRIVATE.has(top ?? "")) router.replace("/");
  }, [phase, segments]);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={theme.dark ? "light-content" : "dark-content"} />
      <PaperProvider theme={theme} settings={{ icon: ({ name, color, size }) => <Icon name={name as string} color={color ?? theme.colors.onSurface} size={size} /> }}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background }, animation: "fade_from_bottom" }}>
          {/* the two places in the navigation bar switch without an animation, as tabs do */}
          <Stack.Screen name="library" options={{ animation: "none" }} />
          <Stack.Screen name="albums" options={{ animation: "none" }} />
          <Stack.Screen name="search" options={{ animation: "none" }} />
        </Stack>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
