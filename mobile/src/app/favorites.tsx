import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Text } from "react-native-paper";
import { Gallery } from "../Gallery";
import { Icon } from "../icons";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { useAppTheme } from "../ui";
import { text } from "../tokens";
import { t } from "../i18n";

/** The photos marked with the heart, newest first. */
export default function Favorites() {
  const th = useAppTheme();
  const { items, error, loading } = useLibrary();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  const favs = useMemo(() => (items ? items.filter((i) => i.favorite && !i.broken) : null), [items]);
  return (
    <Gallery
      items={favs} error={error} loading={loading} onRefresh={refreshLibrary} within="favorites"
      header={
        <Appbar.Header style={{ backgroundColor: th.colors.background }}>
          <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
          <Appbar.Content title={t("Favorites")} titleStyle={text.page} />
        </Appbar.Header>
      }
      empty={
        <View style={st.empty}>
          <View style={[st.disc, { backgroundColor: th.colors.primaryContainer }]}><Icon name="heart" size={30} color={th.colors.primary} /></View>
          <Text variant="headlineSmall" style={{ textAlign: "center", marginBottom: 8 }}>{t("No favorites yet")}</Text>
          <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, maxWidth: 320 }}>
            {t("Tap the heart on a photo to add it here. Favorites sync across your devices.")}
          </Text>
        </View>
      }
    />
  );
}

const st = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  disc: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", marginBottom: 16 },
});
