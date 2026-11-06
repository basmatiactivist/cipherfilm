import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Appbar, Button, Dialog, Menu, Portal, Text } from "react-native-paper";
import { Gallery } from "../../Gallery";
import { Icon } from "../../icons";
import { refreshLibrary, useLibrary } from "../../libraryStore";
import { refreshAlbums, useAlbums } from "../../albumsStore";
import { deleteAlbum, removeFromAlbum, renameAlbum } from "../../albums";
import { NameDialog } from "../albums";
import { Problem, useAppTheme } from "../../ui";
import { text } from "../../tokens";

/** One album: the same timeline, only its photos; Remove from album, rename and delete (the photos stay). */
export default function AlbumScreen() {
  const t = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { albums } = useAlbums();
  const { items, error, loading } = useLibrary();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const remove = async () => {
    setDeleteBusy(true); setDeleteError(undefined);
    try {
      await deleteAlbum(id);
      await refreshAlbums();
      setDeleting(false);
      router.back();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Couldn't delete the album.");
    } finally {
      setDeleteBusy(false);
    }
  };
  useEffect(() => { if (!albums) refreshAlbums(); if (!items) refreshLibrary(); }, []);
  const album = albums?.find((a) => a.id === id);
  const shown = useMemo(() => {
    if (!album || !items) return null;
    const ids = new Set(album.itemIds);
    return items.filter((i) => ids.has(i.id));
  }, [album, items]);
  const count = (n: number) => (n === 1 ? "1 item" : `${n} items`);

  return (
    <View style={{ flex: 1 }}>
      <Gallery
        items={shown} error={error} loading={loading} album={id}
        onRefresh={() => { refreshAlbums(); refreshLibrary(); }}
        header={
          <Appbar.Header style={{ backgroundColor: t.colors.background }}>
            <Appbar.Action icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
            <Appbar.Content title={album?.name ?? ""} titleStyle={text.page} />
            <Menu visible={menu} onDismiss={() => setMenu(false)} anchor={<Appbar.Action icon="more" accessibilityLabel="Album options" onPress={() => setMenu(true)} />}>
              <Menu.Item leadingIcon="edit" title="Rename" onPress={() => { setMenu(false); setRenaming(true); }} />
              <Menu.Item leadingIcon="trash" title="Delete album" onPress={() => { setMenu(false); setDeleteError(undefined); setDeleting(true); }} />
            </Menu>
          </Appbar.Header>
        }
        empty={
          <View style={st.empty}>
            <Icon name="albums" size={32} color={t.colors.onSurfaceVariant} />
            <Text variant="bodyMedium" style={{ textAlign: "center", color: t.colors.onSurfaceVariant, marginTop: 12, maxWidth: 300 }}>
              This album is empty. In Photos, long-press photos and tap Add to album.
            </Text>
          </View>
        }
        extraAction={{
          icon: "minus", label: "Remove",
          run: async (ids) => { await removeFromAlbum(id, ids); await refreshAlbums(); return `Removed ${count(ids.length)} from ${album?.name ?? "the album"}. Still in Photos.`; },
        }}
      />
      <Portal>
        <NameDialog visible={renaming} title="Rename album" action="Rename" initial={album?.name ?? ""} onDismiss={() => setRenaming(false)}
          onSubmit={async (name) => { await renameAlbum(id, name); await refreshAlbums(); setRenaming(false); }} />
        <Dialog visible={deleting} onDismiss={() => setDeleting(false)}>
          <Dialog.Title>Delete this album?</Dialog.Title>
          <Dialog.Content>
            <Problem>{deleteError}</Problem>
            <Text variant="bodyMedium">Its {count(shown?.length ?? 0)} stay in Photos.</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleting(false)}>Cancel</Button>
            <Button onPress={remove} loading={deleteBusy} disabled={deleteBusy}>Delete album</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const st = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, minHeight: 400 },
});
