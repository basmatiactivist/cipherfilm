import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, FlatList, PanResponder, Pressable, StatusBar, StyleSheet, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { Dialog, IconButton, Modal, Portal, ProgressBar, Snackbar, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { previewUri, when, type Item } from "../../library";
import { libraryItems, refreshLibrary, setFavorite } from "../../libraryStore";
import { viewerList } from "../../viewerList";
import { faceUri, facesIn, nameFace, type FaceInPhoto } from "../../search/people";
import { NameDialog } from "../albums";
import { searchReady } from "../../search/engine";
import { refreshAlbums, useAlbums } from "../../albumsStore";
import { addToAlbum, type Album } from "../../albums";
import { api, server } from "../../api";
import N, { ThumbView, VideoView } from "../../../modules/cf-native/src/CfNativeModule";
import { AlbumPicker } from "../../Gallery";
import { Icon, type IconName } from "../../icons";
import { prepareShare, saveItems } from "../../outbox";
import { useAppTheme } from "../../ui";
import { stage } from "../../tokens";
import { Loader } from "../../Loader";

const fmtWhen = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });
const fmtSize = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Full-screen viewer on black, swipe between photos; the info sheet shows what the encrypted metadata says. At the
 *  bottom the same actions as for a selection: Share, Add to album, Save to phone, Trash. */
export default function Viewer() {
  const { id, album, within } = useLocalSearchParams<{ id: string; album?: string; within?: string }>();
  const { albums } = useAlbums();
  const { width, height } = useWindowDimensions();
  const inset = useSafeAreaInsets();
  // opened from an album: swiping stays inside it
  const [list, setList] = useState(() => {
    const all = libraryItems().filter((i) => !i.broken);
    if (within) { // search results or a person: in that order
      const byId = new Map(all.map((i) => [i.id, i]));
      const l = viewerList().map((x) => byId.get(x)).filter((i): i is Item => !!i);
      if (l.length) return l;
    }
    const a = album ? albums?.find((x) => x.id === album) : undefined;
    if (!a) return all;
    const ids = new Set(a.itemIds);
    return all.filter((i) => ids.has(i.id));
  });
  const [start] = useState(() => Math.max(0, list.findIndex((i) => i.id === id)));
  const [index, setIndex] = useState(start);
  const [info, setInfo] = useState(false);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState<{ label: string; progress: number } | null>(null);
  const [note, setNote] = useState<{ text: string; undo?: () => void } | null>(null);
  const pager = useRef<FlatList<Item>>(null);
  const [zoomed, setZoomed] = useState(false);
  const current = list[Math.min(index, list.length - 1)];

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
  const share = async () => {
    let ready: { send: () => Promise<boolean> } | undefined;
    await run("Preparing to share", async (p) => { ready = await prepareShare([current], p); });
    if (ready) await ready.send();
  };
  const save = () => run("Saving to this phone", async (p) => {
    await saveItems([current], p);
    return "Saved to Pictures › Cipherfilm.";
  });
  const intoAlbum = (a: Album) => run("Adding to the album", async () => {
    setPicker(false);
    await addToAlbum(a.id, [current.id]);
    refreshAlbums();
    return `Added to ${a.name}.`;
  });
  const [fav, setFav] = useState<Record<string, boolean>>({});
  const isFav = current ? fav[current.id] ?? !!current.favorite : false;
  const toggleFav = async () => {
    const it = current, next = !isFav;
    setFav((f) => ({ ...f, [it.id]: next }));
    N.haptic();
    try { await setFavorite([it.id], next); } catch (e) {
      setFav((f) => ({ ...f, [it.id]: !next }));
      setNote({ text: e instanceof Error ? e.message : "That didn't work." });
    }
  };
  const trash = () => run("Moving to the trash", async () => {
    const it = current, at = list.indexOf(it);
    await api("POST", "/api/items/trash", { item_ids: [it.id] });
    const rest = list.filter((i) => i !== it);
    if (!rest.length) { refreshLibrary(); refreshAlbums(); router.back(); return; }
    setList(rest);
    setIndex(Math.min(at, rest.length - 1));
    refreshLibrary(); refreshAlbums();
    setNote({
      text: "Moved to the trash.",
      undo: () => run("Restoring", async () => {
        await api("POST", "/api/items/restore", { item_ids: [it.id] });
        setList((l) => [...l.slice(0, at), it, ...l.slice(at)]);
        setIndex(at);
        requestAnimationFrame(() => pager.current?.scrollToIndex({ index: at, animated: false }));
        refreshLibrary(); refreshAlbums();
      }),
    });
  });

  return (
    <View style={st.black}>
      <StatusBar barStyle="light-content" />
      <FlatList
        ref={pager}
        data={list}
        horizontal
        pagingEnabled
        scrollEnabled={!zoomed}
        initialScrollIndex={start}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        keyExtractor={(i) => i.id}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
        extraData={current?.id}
        renderItem={({ item }) => <Page item={item} width={width} height={height} active={item.id === current?.id} onZoom={setZoomed} />}
        windowSize={3}
        initialNumToRender={1}
      />
      <View style={[st.bar, { paddingTop: inset.top + 4, paddingLeft: inset.left + 4, paddingRight: inset.right + 4 }]}>
        <IconButton icon="back" iconColor={stage.onStage} size={24} accessibilityLabel="Back" onPress={() => router.back()} />
        <Text variant="titleSmall" numberOfLines={1} style={st.name}>{current?.meta?.name}</Text>
        <Text variant="labelMedium" style={st.count}>{Math.min(index, list.length - 1) + 1} of {list.length}</Text>
        <IconButton icon="info" iconColor={stage.onStage} size={24} accessibilityLabel="Details" onPress={() => setInfo(true)} />
      </View>
      {current ? (
        <View style={[st.actions, { paddingBottom: inset.bottom + 8, paddingLeft: inset.left, paddingRight: inset.right }]}>
          <Action icon="share" label="Share" onPress={share} />
          <Action icon={isFav ? "heartOn" : "heart"} label="Favorite" onPress={toggleFav} on={isFav} />
          <Action icon="folderPlus" label="Add to album" onPress={() => setPicker(true)} />
          <Action icon="download" label="Save" onPress={save} />
          <Action icon="trash" label="Trash" onPress={trash} />
        </View>
      ) : null}
      {current ? <Info item={current} visible={info} onClose={() => setInfo(false)} /> : null}
      <Portal>
        <Dialog visible={!!busy} dismissable={false}>
          <Dialog.Content>
            <Text variant="bodyLarge" style={{ marginBottom: 12 }}>{busy?.label}…</Text>
            <ProgressBar progress={busy?.progress ?? 0} indeterminate={!busy?.progress} style={{ height: 5, borderRadius: 3 }} />
            <Text variant="bodySmall" style={{ marginTop: 12, opacity: 0.75 }}>Photos are decrypted on this phone. Shared and saved copies are not encrypted.</Text>
          </Dialog.Content>
        </Dialog>
        <AlbumPicker visible={picker} onDismiss={() => setPicker(false)} onPick={intoAlbum} />
      </Portal>
      <Snackbar visible={!!note} onDismiss={() => setNote(null)} duration={5000} style={{ marginBottom: inset.bottom + 88 }}
        action={note?.undo ? { label: "Undo", onPress: () => { const u = note.undo!; setNote(null); u(); } } : undefined}>
        {note?.text}
      </Snackbar>
    </View>
  );
}

function Action({ icon, label, onPress, on }: { icon: IconName; label: string; onPress: () => void; on?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole={on === undefined ? "button" : "switch"} accessibilityState={on === undefined ? undefined : { checked: on }} accessibilityLabel={label}
      android_ripple={{ color: stage.stageOn, borderless: true }} style={st.action}>
      <Icon name={icon} size={24} color={stage.onStage} />
      <Text variant="labelSmall" style={{ color: stage.onStage, marginTop: 6 }} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function Page({ item, width, height, active, onZoom }: { item: Item; width: number; height: number; active: boolean; onZoom: (zoomed: boolean) => void }) {
  const inset = useSafeAreaInsets();
  const [uri, setUri] = useState<string>();
  // a video plays when its page is the one on screen; the player gets the item's key only for that
  const play = active && item.kind === "video" && !!item.itemKey && item.segment_count > 0;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!play) { setReady(false); return; }
    N.videoSource(server(), item.id, item.itemKey!, item.size, item.segment_count);
    setReady(true);
  }, [play, item.id]);
  const [sharp, setSharp] = useState(false);
  useEffect(() => {
    let live = true;
    if (item.has_preview) previewUri(item).then((u) => { if (live) { setUri(u); setSharp(true); } }, () => {});
    return () => { live = false; };
  }, [item.id]);
  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      {!uri && item.has_thumb ? <ThumbView item={item.id} fit="contain" style={{ width, height }} accessibilityLabel={item.meta?.name} /> : null}
      {uri ? (
        <Zoomable width={width} height={height} active={active && !ready} onZoom={onZoom}>
          <Image source={{ uri }} style={{ width, height }} contentFit="contain" cachePolicy="memory" accessibilityLabel={item.meta?.name} />
        </Zoomable>
      ) : null}
      {!sharp && item.has_preview && !ready ? <Loader large style={st.spinner} /> : null}
      {ready ? (
        // the whole page, like the still under it (same fit, so it lines up); the controls keep clear of the bars
        <VideoView item={item.id} controlsInset={[inset.top + 56, inset.bottom + 80]} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} />
      ) : null}
    </View>
  );
}

const MAX_ZOOM = 5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A photo that zooms like in the gallery app: double-tap for 2.5× there (again for all of it), or pinch up to 5×.
 *  While zoomed one finger moves it and the pager holds still; another page resets it. */
function Zoomable({ width, height, active, onZoom, children }: { width: number; height: number; active: boolean; onZoom: (zoomed: boolean) => void; children: React.ReactNode }) {
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const z = useRef({ scale: 1, x: 0, y: 0, mode: "", from: 0, dist: 0, startX: 0, startY: 0, lastTap: 0 }).current;
  const apply = (next: number, x: number, y: number, animate = false) => {
    const k = clamp(next, 1, MAX_ZOOM);
    const mx = (width * (k - 1)) / 2, my = (height * (k - 1)) / 2;
    z.scale = k; z.x = clamp(x, -mx, mx); z.y = clamp(y, -my, my);
    if (animate) {
      Animated.parallel([scale, tx, ty].map((v, i) => Animated.timing(v, { toValue: [z.scale, z.x, z.y][i], duration: 200, useNativeDriver: true }))).start();
    } else { scale.setValue(z.scale); tx.setValue(z.x); ty.setValue(z.y); }
    onZoom(z.scale > 1.01);
  };
  useEffect(() => { if (!active && z.scale !== 1) apply(1, 0, 0); }, [active]);
  const spread = (e: GestureResponderEvent) => {
    const [a, b] = e.nativeEvent.touches;
    return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
  };
  const wants = (e: GestureResponderEvent, g: { dx: number; dy: number }) =>
    active && (e.nativeEvent.touches.length === 2 || (z.scale > 1.01 && Math.abs(g.dx) + Math.abs(g.dy) > 4));
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: wants,
    onMoveShouldSetPanResponder: wants,
    onPanResponderGrant: () => { z.mode = ""; },
    onPanResponderMove: (e, g) => {
      if (e.nativeEvent.touches.length >= 2) {
        if (z.mode !== "pinch") { z.mode = "pinch"; z.from = z.scale; z.dist = spread(e) || 1; }
        apply(z.from * (spread(e) / z.dist), z.x, z.y);
      } else {
        if (z.mode !== "pan") { z.mode = "pan"; z.startX = z.x - g.dx; z.startY = z.y - g.dy; }
        apply(z.scale, z.startX + g.dx, z.startY + g.dy);
      }
    },
    onPanResponderRelease: () => { if (z.scale < 1.05) apply(1, 0, 0, true); },
    onPanResponderTerminationRequest: () => false,
  }), [width, height, active]);
  const tap = (e: GestureResponderEvent) => {
    const now = Date.now();
    if (now - z.lastTap > 300) { z.lastTap = now; return; }
    z.lastTap = 0;
    if (z.scale > 1.01) return apply(1, 0, 0, true);
    const k = 2.5, { locationX, locationY } = e.nativeEvent;
    apply(k, (width / 2 - locationX) * (k - 1), (height / 2 - locationY) * (k - 1), true);
  };
  return (
    <Animated.View {...pan.panHandlers} style={{ width, height, transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>
      <Pressable onPress={tap} accessible={false} style={{ width, height }}>{children}</Pressable>
    </Animated.View>
  );
}

function Info({ item, visible, onClose }: { item: Item; visible: boolean; onClose: () => void }) {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const m = item.meta;
  const rows: [string, string | undefined][] = [
    ["Taken", fmtWhen.format(new Date(when(item)))],
    ["File", m?.name],
    ["Size", fmtSize(item.size) + (m?.width && m?.height ? ` · ${m.width} × ${m.height}` : "")],
    ["Camera", [m?.make, m?.model].filter(Boolean).join(" ") || undefined],
    ["Place", m?.gps ? `${m.gps.lat.toFixed(4)}, ${m.gps.lon.toFixed(4)}` : undefined],
  ];
  return (
    <Portal>
      <Modal visible={visible} onDismiss={onClose} contentContainerStyle={[st.sheet, { backgroundColor: t.colors.background, paddingBottom: inset.bottom + 24 }]} style={{ justifyContent: "flex-end" }}>
        <Text variant="headlineSmall" style={{ marginBottom: 16 }}>Details</Text>
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <View key={k} style={st.row}>
            <Text variant="labelMedium" style={{ color: t.colors.onSurfaceVariant, width: 72 }}>{k}</Text>
            <Text variant="bodyMedium" style={{ flex: 1 }} selectable>{v}</Text>
          </View>
        ))}
        {visible ? <InPhoto item={item} onClose={onClose} /> : null}
        <Text variant="bodySmall" style={{ color: t.colors.onSurfaceVariant, marginTop: 12 }}>Only you can read these details. The server stores them encrypted.</Text>
      </Modal>
    </Portal>
  );
}

/** Who is in the photo: every face found in it, named or not (name one right here), and photos like it. */
function InPhoto({ item, onClose }: { item: Item; onClose: () => void }) {
  const t = useAppTheme();
  const [faces, setFaces] = useState<FaceInPhoto[]>([]);
  const [naming, setNaming] = useState<FaceInPhoto | null>(null);
  const [error, setError] = useState<string>();
  const load = () => facesIn(item.id).then(setFaces, () => {});
  useEffect(() => { load(); }, [item.id]);
  if (!searchReady()) return null;
  return (
    <View style={{ marginTop: 8 }}>
      {faces.length ? (
        <View style={st.row}>
          <Text variant="labelMedium" style={{ color: t.colors.onSurfaceVariant, width: 72, paddingTop: 10 }}>People</Text>
          <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {faces.map((f) => <Face key={f.key} face={f} onPress={() => {
              const name = f.group?.person?.name;
              if (name && f.group) { onClose(); router.push({ pathname: "/person/[key]", params: { key: f.group.key } }); }
              else setNaming(f);
            }} />)}
          </View>
        </View>
      ) : null}
      {error ? <Text variant="bodySmall" style={{ color: t.colors.error }}>{error}</Text> : null}
      <Pressable onPress={() => { onClose(); router.push({ pathname: "/search", params: { similar: item.id } }); }} accessibilityRole="button" style={[st.row, { alignItems: "center" }]}>
        <Text variant="labelMedium" style={{ color: t.colors.onSurfaceVariant, width: 72 }}>Search</Text>
        <Icon name="similar" size={20} color={t.colors.primary} />
        <Text variant="bodyMedium" style={{ color: t.colors.primary }}>Photos like this one</Text>
      </Pressable>
      <NameDialog visible={!!naming} title="Who is this?" action="Save" initial="" onDismiss={() => setNaming(null)}
        onSubmit={async (n) => {
          const f = naming!;
          setNaming(null);
          try { await nameFace(f, n); setError(undefined); await load(); }
          catch (e) { setError(e instanceof Error ? `Couldn't save the name: ${e.message}` : "Couldn't save the name."); }
        }} />
    </View>
  );
}

function Face({ face, onPress }: { face: FaceInPhoto; onPress: () => void }) {
  const t = useAppTheme();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => { let live = true; faceUri(face.cover).then((u) => live && setUri(u), () => {}); return () => { live = false; }; }, [face.key]);
  const name = face.group?.person?.name ?? "";
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={name || "Someone not named yet: add a name"} style={{ alignItems: "center", width: 64 }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, overflow: "hidden", backgroundColor: t.colors.surfaceVariant }}>
        {uri ? <Image source={{ uri }} style={{ width: 48, height: 48 }} cachePolicy="memory" /> : null}
      </View>
      <Text variant="labelSmall" numberOfLines={1} style={{ marginTop: 4, color: name ? t.colors.onSurface : t.colors.primary }}>{name || "Add name"}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  black: { flex: 1, backgroundColor: stage.stage },
  bar: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", alignItems: "center", backgroundColor: stage.stageBar },
  name: { flex: 1, color: stage.onStage },
  count: { color: stage.stageMuted, marginRight: 4, fontVariant: ["tabular-nums"] },
  spinner: { position: "absolute" },
  actions: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", justifyContent: "space-around", paddingTop: 8, backgroundColor: stage.stageBar },
  action: { flex: 1, maxWidth: 110, alignItems: "center", paddingVertical: 8, borderRadius: 12 },
  sheet: { marginTop: "auto", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 24 },
  row: { flexDirection: "row", gap: 12, paddingVertical: 8 },
});
