import { useMemo, useState } from "react";
import { FlatList, StyleSheet, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FaceAvatar } from "../Faces";
import { usePeople } from "../search/people";
import { useSearchProgress } from "../search/engine";
import { useAppTheme } from "../ui";
import { text } from "../tokens";
import { Loading } from "../Loader";
import { locale, t } from "../i18n";

/** Everyone the phone found, named people first. Hidden people are behind the eye in the bar. */
export default function People() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { groups } = usePeople();
  const progress = useSearchProgress();
  const [showHidden, setShowHidden] = useState(false);
  const list = useMemo(() => (groups ?? []).filter((g) => !!g.person?.hidden === showHidden)
    .sort((a, b) => Number(!!b.person?.name) - Number(!!a.person?.name) || b.items.length - a.items.length), [groups, showHidden]);
  const cols = Math.max(3, Math.floor((width - 16) / 104));
  const size = Math.floor((width - 32) / cols) - 24;
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={showHidden ? t("Hidden people") : t("People")} titleStyle={text.page} />
        <Appbar.Action icon={showHidden ? "people" : "lock"} accessibilityLabel={showHidden ? t("Show people") : t("Show hidden people")} onPress={() => setShowHidden((v) => !v)} />
      </Appbar.Header>
      {!groups ? <Loading label={t("Loading people…")} /> : (
        <FlatList data={list} key={cols} numColumns={cols} keyExtractor={(g) => g.key}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: inset.bottom + 24, gap: 16, flexGrow: 1 }}
          renderItem={({ item: g }) => <View style={{ width: (width - 32) / cols, alignItems: "center" }}><FaceAvatar group={g} size={size} count onPress={() => router.push({ pathname: "/person/[key]", params: { key: g.key } })} /></View>}
          ListEmptyComponent={
            <View style={st.empty}>
              <Text variant="titleMedium" style={{ marginBottom: 8 }}>{showHidden ? t("No one is hidden") : t("No people yet")}</Text>
              <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, maxWidth: 320 }}>
                {showHidden ? t("Hidden people stay out of search and this list.") : progress.phase === "indexing" ? t("Faces are found as your photos are indexed ({done} of {total}).", { done: progress.done.toLocaleString(locale()), total: progress.total.toLocaleString(locale()) }) : t("People appear here once they are in at least three photos.")}
              </Text>
            </View>
          } />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, minHeight: 300 },
});
