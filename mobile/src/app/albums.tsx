import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, FAB, Portal, Text, TextInput } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NAV_HEIGHT, NavBar } from "../NavBar";
import { Icon } from "../icons";
import { type Item } from "../library";
import { ThumbView } from "../../modules/cf-native/src/CfNativeModule";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { refreshAlbums, useAlbums } from "../albumsStore";
import { createAlbum, type Album } from "../albums";
import { Problem, useAppTheme } from "../ui";
import { radius, text } from "../tokens";
import { busyIcon, Loading } from "../Loader";

const GAP = 12;
// Favorites sits first in the grid, like an album
const FAVORITES: Album = { id: "favorites", name: "Favorites", itemIds: [] };

/** All albums as a grid of covers (the newest photo in each); names are decrypted on the phone. */
export default function Albums() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { albums, error, loading } = useAlbums();
  const { items } = useLibrary();
  const [creating, setCreating] = useState(false);
  useEffect(() => { refreshAlbums(); if (!items) refreshLibrary(); }, []);
  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const cols = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const size = Math.floor((width - inset.left - inset.right - 16 * 2 - GAP * (cols - 1)) / cols);

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <Appbar.Header style={{ backgroundColor: t.colors.background }}>
        <Appbar.Content title="Albums" titleStyle={text.page} />
        <Appbar.Action icon="trash" accessibilityLabel="Trash" onPress={() => router.push("/trash")} />
        <Appbar.Action icon="user" accessibilityLabel="Account" onPress={() => router.push("/account")} />
      </Appbar.Header>
      <FlatList
        data={albums ? [FAVORITES, ...albums] : []}
        key={cols}
        numColumns={cols}
        keyExtractor={(a) => a.id}
        columnWrapperStyle={cols > 1 ? { gap: GAP } : undefined}
        contentContainerStyle={{ paddingHorizontal: 16 + inset.left, paddingBottom: inset.bottom + NAV_HEIGHT + 96, gap: 20, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={loading && !!albums} onRefresh={() => { refreshAlbums(); refreshLibrary(); }} colors={[t.colors.primary]} progressBackgroundColor={t.colors.elevation.level1} />}
        ListHeaderComponent={error ? <Problem>{error}</Problem> : undefined}
        ListFooterComponent={albums && !albums.length && !error ? <Empty onCreate={() => setCreating(true)} /> : undefined}
        // the first load (names are decrypted on the phone): the badge, not a blank page; the pull-to-refresh spinner
        // above is for the loads after it
        ListEmptyComponent={!albums && !error ? <Loading label="Opening your albums…" /> : undefined}
        renderItem={({ item: a }) => {
          if (a === FAVORITES) return <Special title="Favorites" icon="heart" size={size} items={(items ?? []).filter((i) => i.favorite && !i.broken)} onPress={() => router.push("/favorites")} />;
          const shown = a.itemIds.map((id) => byId.get(id)).filter((i): i is Item => !!i && !i.broken);
          return <Cover album={a} cover={shown[shown.length - 1]} count={shown.length} size={size} />;
        }}
      />
      <FAB icon="plus" label="New album" onPress={() => setCreating(true)} accessibilityLabel="Create an album"
        style={[st.fab, { right: 16 + inset.right, bottom: 16 + inset.bottom + NAV_HEIGHT, backgroundColor: t.colors.primary }]} color={t.colors.onPrimary} />
      <Portal><NameDialog visible={creating} title="New album" action="Create" onDismiss={() => setCreating(false)}
        onSubmit={async (name) => { const a = await createAlbum(name); await refreshAlbums(); setCreating(false); router.push({ pathname: "/album/[id]", params: { id: a.id } }); }} /></Portal>
      <NavBar current="albums" />
    </View>
  );
}

function Cover({ album, cover, count, size }: { album: Album; cover?: Item; count: number; size: number }) {
  const t = useAppTheme();
  const thumb = cover?.has_thumb && !cover.broken ? cover.id : undefined;
  return (
    <Pressable onPress={() => router.push({ pathname: "/album/[id]", params: { id: album.id } })} accessibilityRole="button" accessibilityLabel={`${album.name}, ${count === 1 ? "1 item" : `${count} items`}`} style={{ width: size }}>
      {({ pressed }) => (
        <>
          <View style={[st.cover, { width: size, height: size, backgroundColor: t.colors.surfaceVariant, opacity: pressed ? 0.85 : 1 }]}>
            {thumb ? <ThumbView item={thumb} style={StyleSheet.absoluteFill} /> : <Icon name="albums" size={32} color={t.colors.onSurfaceVariant} />}
          </View>
          <Text numberOfLines={1} style={[text.name, { marginTop: 8 }]}>{album.name}</Text>
          <Text variant="bodySmall" style={{ color: t.colors.onSurfaceVariant }}>{count === 1 ? "1 item" : `${count} items`}</Text>
        </>
      )}
    </Pressable>
  );
}

/** A built-in collection above the albums (Favorites), with its newest photo as the cover. */
function Special({ title, icon, size, items, onPress }: { title: string; icon: "heart"; size: number; items: Item[]; onPress: () => void }) {
  const t = useAppTheme();
  const cover = items[0];
  const thumb = cover?.has_thumb && !cover.broken ? cover.id : undefined;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}, ${items.length === 1 ? "1 item" : `${items.length} items`}`} style={{ width: size }}>
      {({ pressed }) => (
        <>
          <View style={[st.cover, { width: size, height: size, backgroundColor: t.colors.primaryContainer, opacity: pressed ? 0.85 : 1 }]}>
            {thumb ? <ThumbView item={thumb} style={StyleSheet.absoluteFill} /> : null}
            <View style={[st.badge, { backgroundColor: t.colors.background }]}><Icon name={icon === "heart" ? "heartOn" : icon} size={18} color={t.colors.primary} /></View>
          </View>
          <Text numberOfLines={1} style={[text.name, { marginTop: 8 }]}>{title}</Text>
          <Text variant="bodySmall" style={{ color: t.colors.onSurfaceVariant }}>{items.length === 1 ? "1 item" : `${items.length} items`}</Text>
        </>
      )}
    </Pressable>
  );
}

function Empty({ onCreate }: { onCreate: () => void }) {
  const t = useAppTheme();
  return (
    <View style={st.empty}>
      <View style={[st.disc, { backgroundColor: t.colors.primaryContainer }]}><Icon name="albums" size={30} color={t.colors.primary} /></View>
      <Text variant="headlineSmall" style={{ textAlign: "center", marginBottom: 8 }}>No albums yet</Text>
      <Text variant="bodyMedium" style={{ textAlign: "center", color: t.colors.onSurfaceVariant, maxWidth: 320 }}>
        Album names are encrypted too. A photo can be in any number of albums.
      </Text>
      <Button mode="text" onPress={onCreate} style={{ marginTop: 16 }}>Create an album</Button>
    </View>
  );
}

/** A small dialog for an album name (new or renamed). */
export function NameDialog({ visible, title, action, initial = "", onDismiss, onSubmit }: { visible: boolean; title: string; action: string; initial?: string; onDismiss: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setName(initial); setError(undefined); } }, [visible]);
  const go = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await onSubmit(name); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog visible={visible} onDismiss={onDismiss}>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Content>
        {error ? <Problem>{error}</Problem> : null}
        <TextInput mode="outlined" outlineStyle={{ borderRadius: radius.control }} label="Name" value={name} onChangeText={setName} maxLength={100} onSubmitEditing={go} autoFocus />
      </Dialog.Content>
      <Dialog.Actions>
        <Button onPress={onDismiss}>Cancel</Button>
        <Button onPress={go} icon={busy ? busyIcon : undefined} disabled={!name.trim() || busy}>{action}</Button>
      </Dialog.Actions>
    </Dialog>
  );
}

const st = StyleSheet.create({
  cover: { borderRadius: radius.card, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", left: 8, bottom: 8, width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  fab: { position: "absolute" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, minHeight: 300 },
  disc: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", marginBottom: 16 },
});
