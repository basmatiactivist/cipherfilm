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
import { busyIcon } from "../../Loader";
import { t, tn } from "../../i18n";

/** One album: the same timeline, only its photos; Remove from album, rename and delete (the photos stay). */
export default function AlbumScreen() {
  const th = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { albums, error: albumsError, loading: albumsLoading } = useAlbums();
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
      setDeleteError(e instanceof Error ? e.message : t("Couldn't delete the album."));
    } finally {
      setDeleteBusy(false);
    }
  };
  useEffect(() => { if (!albums) refreshAlbums(); if (!items) refreshLibrary(); }, []);
  const album = albums?.find((a) => a.id === id);
  // deleted meanwhile (on another device): said so, instead of the loading badge for ever
  const gone = !!albums && !album;
  const shown = useMemo(() => {
    if (gone && items) return [];
    if (!album || !items) return null;
    const ids = new Set(album.itemIds);
    return items.filter((i) => ids.has(i.id));
  }, [album, items, gone]);

  return (
    <View style={{ flex: 1 }}>
      <Gallery
        items={shown} error={error ?? albumsError} loading={loading || albumsLoading} album={id}
        onRefresh={() => { refreshAlbums(); refreshLibrary(); }}
        header={
          <Appbar.Header style={{ backgroundColor: th.colors.background }}>
            <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
            <Appbar.Content title={album?.name ?? ""} titleStyle={text.page} />
            <Menu visible={menu} onDismiss={() => setMenu(false)} anchor={<Appbar.Action icon="more" accessibilityLabel={t("Album options")} onPress={() => setMenu(true)} />}>
              <Menu.Item leadingIcon="edit" title={t("Rename")} onPress={() => { setMenu(false); setRenaming(true); }} />
              <Menu.Item leadingIcon="trash" title={t("Delete album")} onPress={() => { setMenu(false); setDeleteError(undefined); setDeleting(true); }} />
            </Menu>
          </Appbar.Header>
        }
        empty={
          <View style={st.empty}>
            <Icon name="albums" size={32} color={th.colors.onSurfaceVariant} />
            <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, marginTop: 12, maxWidth: 300 }}>
              {gone ? t("This album isn't there anymore. It may have been deleted on another device.") : t("This album is empty. In Photos, long-press photos and tap Add to album.")}
            </Text>
          </View>
        }
        extraAction={{
          icon: "minus", label: t("Remove"),
          run: async (ids) => { await removeFromAlbum(id, ids); await refreshAlbums(); return album?.name ? tn(ids.length, "Removed {n} item from {album}. Still in Photos.", "Removed {n} items from {album}. Still in Photos.", { album: album.name }) : tn(ids.length, "Removed {n} item from the album. Still in Photos.", "Removed {n} items from the album. Still in Photos."); },
        }}
      />
      <Portal>
        <NameDialog visible={renaming} title={t("Rename album")} action={t("Rename")} initial={album?.name ?? ""} onDismiss={() => setRenaming(false)}
          onSubmit={async (name) => { await renameAlbum(id, name); await refreshAlbums(); setRenaming(false); }} />
        <Dialog visible={deleting} onDismiss={() => setDeleting(false)}>
          <Dialog.Title>{t("Delete this album?")}</Dialog.Title>
          <Dialog.Content>
            <Problem>{deleteError}</Problem>
            <Text variant="bodyMedium">{tn(shown?.length ?? 0, "Its {n} item stays in Photos.", "Its {n} items stay in Photos.")}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleting(false)}>{t("Cancel")}</Button>
            <Button onPress={remove} icon={deleteBusy ? busyIcon : undefined} disabled={deleteBusy}>{t("Delete album")}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const st = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, minHeight: 400 },
});
