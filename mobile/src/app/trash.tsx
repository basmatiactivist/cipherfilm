import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Text } from "react-native-paper";
import { Gallery, type ExtraAction } from "../Gallery";
import { Icon } from "../icons";
import { loadTrash, type Item } from "../library";
import { refreshLibrary } from "../libraryStore";
import { refreshAlbums } from "../albumsStore";
import { api } from "../api";
import { onTrashChanged } from "../liveSync";
import { useAppTheme } from "../ui";
import { text } from "../tokens";
import { t, tn } from "../i18n";

/** The trash: tap photos to select them, then restore them or delete them permanently. The server deletes them on its
 *  own after the retention time. */
export default function Trash() {
  const th = useAppTheme();
  const [items, setItems] = useState<Item[] | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const r = await loadTrash();
      setItems(r.items); setDays(r.retentionDays);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Couldn't load the trash."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  // moved to the trash, restored or deleted on another device: shown here too (quietly, as the library does)
  useEffect(() => onTrashChanged(() => {
    loadTrash().then((r) => { setItems(r.items); setDays(r.retentionDays); }, () => {});
  }), []);

  const inBatches = async (path: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 500) await api("POST", path, { item_ids: ids.slice(i, i + 500) });
  };
  const actions: ExtraAction[] = [
    {
      icon: "restore", label: t("Restore"),
      run: async (ids) => {
        await inBatches("/api/items/restore", ids);
        await load(); refreshLibrary(); refreshAlbums();
        return tn(ids.length, "Restored {n} item to Photos.", "Restored {n} items to Photos.");
      },
    },
    {
      icon: "trash", label: t("Delete forever"),
      confirm: (n) => [tn(n, "Delete {n} item forever?", "Delete {n} items forever?"), tn(n, "It is deleted from the server and can't be restored, not even from a backup made after today.", "They are deleted from the server and can't be restored, not even from a backup made after today."), t("Delete forever")],
      run: async (ids) => {
        await inBatches("/api/trash/purge", ids);
        await load(); refreshAlbums();
        return tn(ids.length, "Deleted {n} item permanently.", "Deleted {n} items permanently.");
      },
    },
  ];

  return (
    <Gallery
      items={items} error={error} loading={loading} onRefresh={load} actions={actions} within="trash"
      header={
        <View>
          <Appbar.Header style={{ backgroundColor: th.colors.background }}>
            <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
            <Appbar.Content title={t("Trash")} titleStyle={text.page} />
          </Appbar.Header>
          {items?.length ? (
            <Text variant="bodyMedium" style={[st.note, { color: th.colors.onSurfaceVariant }]}>
              {tn(days, "Tap photos to restore or delete them. Items are permanently deleted after {n} day.", "Tap photos to restore or delete them. Items are permanently deleted after {n} days.")}
            </Text>
          ) : null}
        </View>
      }
      empty={
        <View style={st.empty}>
          <View style={[st.disc, { backgroundColor: th.colors.primaryContainer }]}><Icon name="trash" size={30} color={th.colors.primary} /></View>
          <Text variant="headlineSmall" style={{ textAlign: "center", marginBottom: 8 }}>{t("The trash is empty")}</Text>
          <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, maxWidth: 320 }}>
            {tn(days, "Deleted photos and videos stay here for {n} day.", "Deleted photos and videos stay here for {n} days.")}
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
