import { Pressable, StatusBar, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./icons";
import { useAppTheme } from "./ui";

export const NAV_HEIGHT = 80;
type Tab = "library" | "search" | "albums";

/** Material 3 navigation bar with the top-level places. Switching replaces the screen, so Back leaves the app. */
export function NavBar({ current }: { current: Tab }) {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const tabs: { key: Tab; label: string; icon: IconName }[] = [
    { key: "library", label: "Photos", icon: "photos" }, { key: "search", label: "Search", icon: "search" }, { key: "albums", label: "Albums", icon: "albums" },
  ];
  return (
    <View accessibilityRole="tablist" style={[st.bar, { height: NAV_HEIGHT + inset.bottom, paddingBottom: inset.bottom, backgroundColor: t.colors.surfaceVariant }]}>
      {/* the top-level places are on paper: dark status bar icons, also when the viewer was on screen before */}
      <StatusBar barStyle={t.dark ? "light-content" : "dark-content"} />
      {tabs.map((tab) => {
        const on = tab.key === current;
        return (
          <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={tab.label}
            onPress={() => { if (!on) router.replace(`/${tab.key}`); }} style={st.item}>
            <View style={[st.pill, on && { backgroundColor: t.colors.primaryContainer }]}>
              <Icon name={tab.icon} size={24} color={on ? t.colors.onPrimaryContainer : t.colors.onSurfaceVariant} />
            </View>
            <Text variant="labelMedium" style={{ color: on ? t.colors.onSurface : t.colors.onSurfaceVariant, fontWeight: on ? "700" : "500" }}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const st = StyleSheet.create({
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row" },
  item: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4 },
  pill: { width: 64, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
