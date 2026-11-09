import { Pressable, StatusBar, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./icons";
import { useAppTheme } from "./ui";
import { t } from "./i18n";
import { useSession } from "./session";

export const NAV_HEIGHT = 80;
type Tab = "library" | "search" | "albums" | "map";

/** Material 3 navigation bar with the top-level places. Switching replaces the screen, so Back leaves the app. */
export function NavBar({ current }: { current: Tab }) {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const map = !!useSession().me?.map; // the server may have turned the map off (MAP_STYLE=off)
  const tabs: { key: Tab; label: string; icon: IconName }[] = [
    { key: "library", label: t("Photos"), icon: "photos" }, { key: "search", label: t("Search"), icon: "search" }, { key: "albums", label: t("Albums"), icon: "albums" },
    ...(map ? [{ key: "map" as Tab, label: t("Map"), icon: "map" as IconName }] : []),
  ];
  return (
    <View accessibilityRole="tablist" style={[st.bar, { height: NAV_HEIGHT + inset.bottom, paddingBottom: inset.bottom, backgroundColor: th.colors.surfaceVariant }]}>
      {/* the top-level places are on paper: dark status bar icons, also when the viewer was on screen before */}
      <StatusBar barStyle={th.dark ? "light-content" : "dark-content"} />
      {tabs.map((tab) => {
        const on = tab.key === current;
        return (
          <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={tab.label}
            onPress={() => { if (!on) router.replace(`/${tab.key}`); }} style={st.item}>
            <View style={[st.pill, on && { backgroundColor: th.colors.primaryContainer }]}>
              <Icon name={tab.icon} size={24} color={on ? th.colors.onPrimaryContainer : th.colors.onSurfaceVariant} />
            </View>
            <Text variant="labelMedium" style={{ color: on ? th.colors.onSurface : th.colors.onSurfaceVariant, fontWeight: on ? "700" : "500" }}>{tab.label}</Text>
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
