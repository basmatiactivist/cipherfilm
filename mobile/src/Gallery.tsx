import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, useWindowDimensions, View } from "react-native";
import { type ReactNode } from "react";
import { router, useFocusEffect } from "expo-router";
import { ActivityIndicator, Button, Dialog, List, Portal, ProgressBar, Snackbar, Text, TextInput } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N from "../modules/cf-native/src/CfNativeModule";
import { Problem, useAppTheme } from "./ui";
import { Tile } from "./Tile";
import { Icon, type IconName } from "./icons";
import { when, type Item } from "./library";
import { refreshLibrary, setFavorite } from "./libraryStore";
import { api } from "./api";
import { addToAlbum, createAlbum, loadAlbums, type Album } from "./albums";
import { refreshAlbums } from "./albumsStore";
import { prepareShare, saveItems } from "./outbox";
import { setViewerList } from "./viewerList";
import { radius, text } from "./tokens";

const GAP = 4;
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** An extra action for the selection bar, e.g. "Remove from album". Returns the message to show. */
export interface ExtraAction {
  icon: IconName; label: string; run: (ids: string[]) => Promise<string | void>;
  /** asked first, for what can't be undone: [title, text, button] */
  confirm?: (n: number) => [string, string, string];
}

interface Props {
  items: Item[] | null;
  error?: string;
  loading: boolean;
  onRefresh: () => void;
  /** shown above the grid when nothing is selected */
  header: ReactNode;
  empty: ReactNode;
  /** extra space below the grid, e.g. for a navigation bar */
  bottom?: number;
  /** a floating button, hidden while selecting */
  fab?: ReactNode;
  /** a navigation bar at the bottom; the selection actions take its place while selecting */
  nav?: ReactNode;
  extraAction?: ExtraAction;
  /** replaces the usual selection actions (the trash: Restore, Delete forever); a tap then selects instead of opening */
  actions?: ExtraAction[];
  /** passed to the viewer, so swiping stays inside this album */
  album?: string;
  /** one grid in the given order (search results, best first), without day headings */
  flat?: boolean;
  /** passed to the viewer: swiping stays inside these items (search results, a person) */
  within?: string;
}

/** The timeline: day headings, square tiles, and selection as in Google Photos (long press, then tap; Back ends it)
 *  with the actions Share, Add to album, Save to phone, Trash and an optional extra one. */
/** One row of tiles; renders again only when its items, the tile size or their selection change. */
const Row = memo(function Row(p: { row: Item[]; size: number; selecting: boolean; sel: string; onPress: (it: Item) => void; onLongPress: (it: Item) => void }) {
  return (
    <View style={st.row}>
      {p.row.map((it, i) => <Tile key={it.id} item={it} size={p.size} selecting={p.selecting} selected={p.sel[i] === "1"} onPress={p.onPress} onLongPress={p.onLongPress} />)}
    </View>
  );
});

export function Gallery({ items, error, loading, onRefresh, header, empty, bottom = 0, fab, nav, extraAction, actions, album, flat, within }: Props) {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<{ label: string; progress: number } | null>(null);
  const [note, setNote] = useState<{ text: string; undo?: () => void } | null>(null);
  const [albumPicker, setAlbumPicker] = useState(false);
  const [asking, setAsking] = useState<ExtraAction | null>(null);
  const selecting = selected.size > 0;

  // the system Back gesture ends a selection first
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (selected.size) { setSelected(new Set()); return true; }
      return false;
    });
    return () => sub.remove();
  }, [selected]));

  const cols = width >= 900 ? 6 : width >= 600 ? 4 : 3;
  const size = Math.floor((width - inset.left - inset.right - GAP * (cols + 1)) / cols);
  const sections = useMemo(() => {
    if (flat) {
      const rows: Item[][] = [];
      const list = items ?? [];
      for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols));
      return rows.length ? [{ title: "", data: rows }] : [];
    }
    const days = new Map<string, Item[]>();
    for (const it of items ?? []) {
      const key = new Date(when(it)).toDateString();
      (days.get(key) ?? days.set(key, []).get(key)!).push(it);
    }
    return [...days.entries()].map(([day, list]) => {
      const rows: Item[][] = [];
      for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols));
      return { title: dayFmt.format(new Date(day)), data: rows };
    });
  }, [items, cols, flat]);

  // a long press starts (or extends) the selection, with the system's own long-press vibration
  const hold = useCallback((it: Item) => { N.haptic(); toggle(it); }, []);
  const toggle = useCallback((it: Item) => setSelected((s) => {
    const n = new Set(s);
    n.has(it.id) ? n.delete(it.id) : n.add(it.id);
    return n;
  }), []);
  // read through refs, so press keeps its identity and a tile renders again only when what it shows changes
  const live = useRef({ selected, items });
  live.current = { selected, items };
  const press = useCallback((it: Item) => {
    if (live.current.selected.size || actions) toggle(it);
    else if (!it.broken) {
      if (within) setViewerList((live.current.items ?? []).map((i) => i.id));
      router.push({ pathname: "/photo/[id]", params: album ? { id: it.id, album } : within ? { id: it.id, within } : { id: it.id } });
    }
  }, [toggle, album, actions, within]);

  const picked = () => (items ?? []).filter((i) => selected.has(i.id) && !i.broken);
  const run = async (label: string, f: (p: (done: number, total: number) => void) => Promise<string | void>) => {
    setBusy({ label, progress: 0 });
    try {
      const msg = await f((d, tot) => setBusy({ label, progress: tot ? d / tot : 0 }));
      if (msg) setNote({ text: msg });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "That didn't work." });
    } finally {
      setBusy(null);
    }
  };
  const count = (n: number) => (n === 1 ? "1 item" : `${n} items`);

  const share = async () => {
    let ready: { send: () => Promise<boolean> } | undefined;
    await run("Preparing to share", async (p) => { ready = await prepareShare(picked(), p); });
    if (ready) { await ready.send(); setSelected(new Set()); }
  };
  const save = () => run("Saving to this phone", async (p) => {
    const list = picked();
    await saveItems(list, p);
    setSelected(new Set());
    return `Saved ${count(list.length)} to Pictures › Cipherfilm.`;
  });
  const trash = () => run("Moving to the trash", async () => {
    const ids = [...selected];
    for (let i = 0; i < ids.length; i += 500) await api("POST", "/api/items/trash", { item_ids: ids.slice(i, i + 500) });
    setSelected(new Set());
    await refreshLibrary();
    refreshAlbums();
    setNote({
      text: `Moved ${count(ids.length)} to the trash.`,
      undo: () => run("Restoring", async () => {
        for (let i = 0; i < ids.length; i += 500) await api("POST", "/api/items/restore", { item_ids: ids.slice(i, i + 500) });
        await refreshLibrary();
        refreshAlbums();
      }),
    });
  });
  const allFav = picked().length > 0 && picked().every((i) => i.favorite);
  const favorite = () => run(allFav ? "Removing from favorites" : "Adding to favorites", async () => {
    const ids = picked().map((i) => i.id);
    await setFavorite(ids, !allFav);
    setSelected(new Set());
    return allFav ? `Removed ${count(ids.length)} from favorites.` : `Added ${count(ids.length)} to favorites.`;
  });
  const intoAlbum = (a: Album) => run("Adding to the album", async () => {
    setAlbumPicker(false);
    const ids = picked().map((i) => i.id);
    await addToAlbum(a.id, ids);
    setSelected(new Set());
    refreshAlbums();
    return `Added ${count(ids.length)} to ${a.name}.`;
  });

  const runAction = (a: ExtraAction) => run(a.label, async () => {
    const msg = await a.run([...selected]);
    setSelected(new Set());
    return msg;
  });

  const extra = extraAction && (() => run(extraAction.label, async () => {
    const msg = await extraAction.run([...selected]);
    setSelected(new Set());
    return msg;
  }));

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      {selecting ? (
        <View style={[st.selhead, { paddingTop: inset.top + 8, paddingLeft: inset.left + 16 }]}>
          <View style={[st.countpill, { backgroundColor: t.colors.surfaceVariant }]}>
            <Pressable onPress={() => setSelected(new Set())} accessibilityRole="button" accessibilityLabel="End selection" hitSlop={8} style={st.pillx}>
              <Icon name="x" size={22} color={t.colors.onSurface} />
            </Pressable>
            <Text variant="titleMedium" style={{ fontVariant: ["tabular-nums"], marginRight: 16 }} accessibilityLiveRegion="polite">{selected.size}</Text>
          </View>
          {/* all of what is shown: a person's photos, an album, search results */}
          <Pressable onPress={() => { const all = (items ?? []).filter((i) => !i.broken); setSelected(selected.size >= all.length ? new Set() : new Set(all.map((i) => i.id))); }}
            accessibilityRole="button" hitSlop={8} style={[st.countpill, { backgroundColor: t.colors.surfaceVariant, marginLeft: 8, paddingHorizontal: 16 }]}>
            <Text variant="labelLarge">{selected.size >= (items ?? []).filter((i) => !i.broken).length ? "Select none" : "Select all"}</Text>
          </Pressable>
        </View>
      ) : header}
      <SectionList
        sections={sections}
        keyExtractor={(row) => row[0].id}
        stickySectionHeadersEnabled={false}
        extraData={selected}
        contentContainerStyle={{ paddingHorizontal: GAP + inset.left, paddingBottom: inset.bottom + bottom + (selecting ? 160 : 96), flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={loading && !!items} onRefresh={onRefresh} enabled={!selecting} colors={[t.colors.primary]} progressBackgroundColor={t.colors.elevation.level1} />}
        renderSectionHeader={({ section }) => (section.title ? <Text style={[st.day, text.heading]}>{section.title}</Text> : <View style={{ height: 8 }} />)}
        renderItem={({ item: row }) => (
          <Row row={row} size={size} selecting={selecting} sel={row.map((it) => (selected.has(it.id) ? "1" : "0")).join("")} onPress={press} onLongPress={hold} />
        )}
        ListHeaderComponent={error ? <View style={{ paddingTop: 8 }}><Problem>{error}</Problem></View> : undefined}
        ListEmptyComponent={items && !error ? <>{empty}</> : undefined}
        initialNumToRender={12}
        maxToRenderPerBatch={6}
        updateCellsBatchingPeriod={30}
        windowSize={9}
        removeClippedSubviews
      />
      {selecting ? (
        <View style={[st.sheet, { backgroundColor: t.colors.surfaceVariant, paddingBottom: inset.bottom + 12 }]}>
          <View style={[st.grabber, { backgroundColor: t.colors.outline }]} />
          <View style={st.actions}>
            {actions ? actions.map((a) => (
              <Action key={a.label} icon={a.icon} label={a.label} onPress={() => (a.confirm ? setAsking(a) : runAction(a))} />
            )) : (
              <>
                <Action icon="share" label="Share" onPress={share} />
                <Action icon={allFav ? "heartOn" : "heart"} label={allFav ? "Unfavorite" : "Favorite"} onPress={favorite} />
                {extraAction && extra ? <Action icon={extraAction.icon} label={extraAction.label} onPress={extra} /> : null}
                <Action icon="folderPlus" label="Add to album" onPress={() => setAlbumPicker(true)} />
                <Action icon="download" label="Save to phone" onPress={save} />
                <Action icon="trash" label="Trash" onPress={trash} />
              </>
            )}
          </View>
        </View>
      ) : <>{fab}{nav}</>}
      <Portal>
        <Dialog visible={!!busy} dismissable={false}>
          <Dialog.Content>
            <Text variant="bodyLarge" style={{ marginBottom: 12 }}>{busy?.label}…</Text>
            <ProgressBar progress={busy?.progress ?? 0} indeterminate={!busy?.progress} color={t.colors.primary} style={{ height: 5, borderRadius: 3, backgroundColor: t.colors.outlineVariant }} />
            <Text variant="bodySmall" style={{ marginTop: 12, color: t.colors.onSurfaceVariant }}>Photos are decrypted on this phone. Shared and saved copies are not encrypted.</Text>
          </Dialog.Content>
        </Dialog>
        <AlbumPicker visible={albumPicker} onDismiss={() => setAlbumPicker(false)} onPick={intoAlbum} />
        {asking?.confirm ? (() => {
          const [title, text, button] = asking.confirm(selected.size);
          return (
            <Dialog visible onDismiss={() => setAsking(null)}>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Content><Text variant="bodyMedium">{text}</Text></Dialog.Content>
              <Dialog.Actions>
                <Button onPress={() => setAsking(null)}>Cancel</Button>
                <Button textColor={t.colors.error} onPress={() => { const a = asking; setAsking(null); runAction(a); }}>{button}</Button>
              </Dialog.Actions>
            </Dialog>
          );
        })() : null}
      </Portal>
      <Snackbar visible={!!note} onDismiss={() => setNote(null)} duration={5000} style={{ marginBottom: inset.bottom + bottom + (selecting ? 140 : 80) }}
        action={note?.undo ? { label: "Undo", onPress: () => { const u = note.undo!; setNote(null); u(); } } : undefined}>
        {note?.text}
      </Snackbar>
    </View>
  );
}

function Action({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const t = useAppTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} android_ripple={{ color: t.colors.primaryContainer, borderless: true }} style={st.action}>
      <Icon name={icon} size={26} color={t.colors.onSurface} />
      <Text variant="labelMedium" style={{ textAlign: "center", marginTop: 8 }} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

export function AlbumPicker({ visible, onDismiss, onPick }: { visible: boolean; onDismiss: () => void; onPick: (a: Album) => void }) {
  const t = useAppTheme();
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!visible) return;
    setAlbums(null); setName(""); setError(undefined);
    loadAlbums().then((a) => setAlbums(a.filter((x) => !x.broken).sort((x, y) => x.name.localeCompare(y.name))), (e) => setError((e as Error).message));
  }, [visible]);
  const create = async () => {
    try { onPick(await createAlbum(name)); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Dialog visible={visible} onDismiss={onDismiss} style={{ maxHeight: "80%" }}>
      <Dialog.Title>Add to album</Dialog.Title>
      <Dialog.ScrollArea style={{ paddingHorizontal: 0 }}>
        <ScrollView>
          {error ? <View style={{ paddingHorizontal: 24 }}><Problem>{error}</Problem></View> : null}
          {!albums && !error ? <ActivityIndicator style={{ margin: 24 }} /> : null}
          {albums?.map((a) => (
            <List.Item key={a.id} title={a.name} description={a.itemIds.length === 1 ? "1 item" : `${a.itemIds.length} items`} onPress={() => onPick(a)}
              left={() => <View style={{ justifyContent: "center", marginLeft: 16 }}><Icon name="folderPlus" color={t.colors.primary} /></View>} style={{ minHeight: 56 }} />
          ))}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 12 }}>
            <TextInput mode="outlined" outlineStyle={{ borderRadius: radius.control }} dense label="New album" value={name} onChangeText={setName} style={{ flex: 1 }} onSubmitEditing={() => name.trim() && create()} />
            <Button mode="contained" onPress={create} disabled={!name.trim()}>Create</Button>
          </View>
        </ScrollView>
      </Dialog.ScrollArea>
      <Dialog.Actions><Button onPress={onDismiss}>Cancel</Button></Dialog.Actions>
    </Dialog>
  );
}

const st = StyleSheet.create({
  day: { paddingTop: 20, paddingBottom: 8, paddingHorizontal: 4 },
  row: { flexDirection: "row", gap: GAP, marginBottom: GAP },
  selhead: { paddingBottom: 12, flexDirection: "row", alignItems: "center" },
  countpill: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", height: 48, borderRadius: 24, gap: 12 },
  pillx: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10 },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginBottom: 8, opacity: 0.6 },
  actions: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: 4 },
  action: { flex: 1, maxWidth: 120, minHeight: 80, alignItems: "center", justifyContent: "flex-start", paddingVertical: 8, borderRadius: 12 },
});
