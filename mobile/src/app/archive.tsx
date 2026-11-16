import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Text } from "react-native-paper";
import { archived } from "@edit/folders";
import { Gallery } from "../Gallery";
import { Icon } from "../icons";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { useAppTheme } from "../ui";
import { text } from "../tokens";
import { t } from "../i18n";

/** The archive: photos and videos kept out of the photos grid and On this day, newest first. They stay in albums,
 *  search, people, the map and favorites; Unarchive (under More) brings them back to the grid. Which items are
 *  archived is inside their encrypted metadata (@edit/folders). */
export default function Archive() {
  const th = useAppTheme();
  const { items, error, loading } = useLibrary();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  const shown = useMemo(() => (items ? archived(items) : null), [items]);
  return (
    <Gallery
      items={shown} error={error} loading={loading} onRefresh={refreshLibrary} folder="archive"
      header={
        <View>
          <Appbar.Header style={{ backgroundColor: th.colors.background }}>
            <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
            <Appbar.Content title={t("Archive")} titleStyle={text.page} />
          </Appbar.Header>
          {shown?.length ? (
            <Text variant="bodyMedium" style={[st.note, { color: th.colors.onSurfaceVariant }]}>
              {t("Not in the photos grid or On this day. Still in albums, search and the map.")}
            </Text>
          ) : null}
        </View>
      }
      empty={
        <View style={st.empty}>
          <View style={[st.disc, { backgroundColor: th.colors.primaryContainer }]}><Icon name="archive" size={30} color={th.colors.primary} /></View>
          <Text variant="headlineSmall" style={{ textAlign: "center", marginBottom: 8 }}>{t("Nothing archived")}</Text>
          <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, maxWidth: 320 }}>
            {t("Select photos, then More › Archive to keep them out of the photos grid without deleting them. Archive syncs across your devices.")}
          </Text>
        </View>
      }
    />
  );
}

const st = StyleSheet.create({
  note: { paddingHorizontal: 16, paddingBottom: 4 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  disc: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", marginBottom: 16 },
});
