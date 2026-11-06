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
import { useAppTheme } from "../ui";
import { text } from "../tokens";

const count = (n: number) => (n === 1 ? "1 item" : `${n} items`);

/** The trash: tap photos to select them, then restore them or delete them permanently. The server deletes them on its
 *  own after the retention time. */
export default function Trash() {
  const t = useAppTheme();
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
      setError(e instanceof Error ? e.message : "Couldn't load the trash.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const inBatches = async (path: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 500) await api("POST", path, { item_ids: ids.slice(i, i + 500) });
  };
  const actions: ExtraAction[] = [
    {
      icon: "restore", label: "Restore",
      run: async (ids) => {
        await inBatches("/api/items/restore", ids);
        await load(); refreshLibrary(); refreshAlbums();
        return `Restored ${count(ids.length)} to Photos.`;
      },
    },
    {
      icon: "trash", label: "Delete forever",
      confirm: (n) => [`Delete ${count(n)} forever?`, "They are removed from the server and can't be restored, also not from a backup made after today.", "Delete forever"],
      run: async (ids) => {
        await inBatches("/api/trash/purge", ids);
        await load(); refreshAlbums();
        return `Deleted ${count(ids.length)} permanently.`;
      },
    },
  ];

  return (
    <Gallery
      items={items} error={error} loading={loading} onRefresh={load} actions={actions}
      header={
        <View>
          <Appbar.Header style={{ backgroundColor: t.colors.background }}>
            <Appbar.Action icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
            <Appbar.Content title="Trash" titleStyle={text.page} />
          </Appbar.Header>
          {items?.length ? (
            <Text variant="bodyMedium" style={[st.note, { color: t.colors.onSurfaceVariant }]}>
              Tap photos to restore them or delete them permanently. Items are deleted automatically {days} days after they were moved here.
            </Text>
          ) : null}
        </View>
      }
      empty={
        <View style={st.empty}>
          <View style={[st.disc, { backgroundColor: t.colors.primaryContainer }]}><Icon name="trash" size={30} color={t.colors.primary} /></View>
          <Text variant="headlineSmall" style={{ textAlign: "center", marginBottom: 8 }}>The trash is empty</Text>
          <Text variant="bodyMedium" style={{ textAlign: "center", color: t.colors.onSurfaceVariant, maxWidth: 320 }}>
            Photos and videos you move to the trash wait here, and can be restored for {days} days.
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
