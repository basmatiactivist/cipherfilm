import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, Easing, FlatList, PanResponder, Pressable, StatusBar, StyleSheet, useWindowDimensions, View, type GestureResponderEvent } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
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
import { motion, stage } from "../../tokens";
import { Loading, useReducedMotion } from "../../Loader";
import { hideSystemBars, largestInsets, type Insets } from "../../immersive";
import { taps } from "../../taps";
import { locale, t } from "../../i18n";

const fmtWhen = (ms: number) => new Intl.DateTimeFormat(locale(), { dateStyle: "full", timeStyle: "short" }).format(new Date(ms));
const one = (n: number) => n.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtSize = (n: number) => (n >= 1e9 ? `${one(n / 1e9)} GB` : n >= 1e6 ? `${one(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3)).toLocaleString(locale())} KB`);

/** Full-screen viewer on black, swipe between photos; the info sheet shows what the encrypted metadata says. At the
 *  bottom the same actions as for a selection: Share, Add to album, Save to phone, Trash. A tap on the photo hides the
 *  bars, Android's too, for only the photo (as in the gallery app); another brings them back. */
export default function Viewer() {
  const { id, album, within } = useLocalSearchParams<{ id: string; album?: string; within?: string }>();
  const { albums } = useAlbums();
  const { width, height } = useWindowDimensions();
  // the room the system bars take even while they are hidden, so nothing moves when they come and go
  const safe = useSafeAreaInsets();
  const kept = useRef<Insets>(safe);
  kept.current = largestInsets(kept.current, safe);
  const inset = kept.current;
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
  // the pages still loading (decrypting a photo, preparing a video): the badge in the corner is for the one on screen
  const [loads, setLoads] = useState<Record<string, boolean>>({});
  const onLoading = useCallback((item: string, on: boolean) => setLoads((m) => (!!m[item] === on ? m : { ...m, [item]: on })), []);
  const [barHeight, setBarHeight] = useState(0);

  // the bars: shown, or hidden for only the photo; swiping to the next photo keeps it so
  const [chrome, setChrome] = useState(true);
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);
  const reduced = useReducedMotion();
  const shown = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) { shown.setValue(chrome ? 1 : 0); return; }
    const a = Animated.timing(shown, { toValue: chrome ? 1 : 0, duration: motion.fast, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [chrome, reduced]);
  // Android's bars go with them, only while the viewer is on top: a screen opened from it (a person, similar photos),
  // leaving it and locking (which replaces it) all bring them back
  const focused = useRef(false);
  const chromeNow = useRef(chrome);
  chromeNow.current = chrome;
  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (!chromeNow.current) hideSystemBars(true);
    return () => { focused.current = false; hideSystemBars(false); };
  }, []));
  useEffect(() => { if (focused.current) hideSystemBars(!chrome); }, [chrome]);
  // back from the share sheet or another app: Android may have shown them again
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active" && focused.current && !chromeNow.current) hideSystemBars(true); });
    return () => sub.remove();
  }, []);

  const run = async (label: string, f: (p: (done: number, total: number) => void) => Promise<string | void>) => {
    setBusy({ label, progress: 0 });
    try {
      const msg = await f((d, tot) => setBusy({ label, progress: tot ? d / tot : 0 }));
      if (msg) setNote({ text: msg });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : t("That didn't work.") });
    } finally {
      setBusy(null);
    }
  };
  const share = async () => {
    let ready: { send: () => Promise<boolean> } | undefined;
    await run(t("Preparing to share"), async (p) => { ready = await prepareShare([current], p); });
    if (ready) await ready.send();
  };
  const save = () => run(t("Saving to this phone"), async (p) => {
    await saveItems([current], p);
    return t("Saved to Pictures › Cipherfilm.");
  });
  const intoAlbum = (a: Album) => run(t("Adding to the album"), async () => {
    setPicker(false);
    await addToAlbum(a.id, [current.id]);
    refreshAlbums();
    return t("Added to {album}.", { album: a.name });
  });
  const [fav, setFav] = useState<Record<string, boolean>>({});
  const isFav = current ? fav[current.id] ?? !!current.favorite : false;
  const toggleFav = async () => {
    const it = current, next = !isFav;
    setFav((f) => ({ ...f, [it.id]: next }));
    N.haptic();
    try { await setFavorite([it.id], next); } catch (e) {
      setFav((f) => ({ ...f, [it.id]: !next }));
      setNote({ text: e instanceof Error ? e.message : t("That didn't work.") });
    }
  };
  const trash = () => run(t("Moving to the trash"), async () => {
    const it = current, at = list.indexOf(it);
    await api("POST", "/api/items/trash", { item_ids: [it.id] });
    const rest = list.filter((i) => i !== it);
    if (!rest.length) { refreshLibrary(); refreshAlbums(); router.back(); return; }
    setList(rest);
    setIndex(Math.min(at, rest.length - 1));
    refreshLibrary(); refreshAlbums();
    setNote({
      text: t("Moved to the trash."),
      undo: () => run(t("Restoring"), async () => {
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
        extraData={`${current?.id} ${chrome} ${inset.top} ${inset.bottom}`}
        renderItem={({ item }) => (
          <Page item={item} width={width} height={height} inset={inset} active={item.id === current?.id} onZoom={setZoomed}
            chrome={chrome} onTap={toggleChrome} onChrome={setChrome} onLoading={onLoading} />
        )}
        windowSize={3}
        initialNumToRender={1}
      />
      {current && loads[current.id] ? (
        // in the corner above the bottom bar, not over the photo; it stays there while the bars are hidden
        <View pointerEvents="none" style={[st.loading, { left: inset.left + 16, bottom: (barHeight || inset.bottom + 88) + 12 }]}>
          <Loading corner stage label={current.kind === "video" ? t("Loading the video…") : t("Loading the photo…")} />
        </View>
      ) : null}
      <Animated.View pointerEvents={chrome ? "auto" : "none"} importantForAccessibility={chrome ? "auto" : "no-hide-descendants"}
        style={[st.bar, { opacity: shown, paddingTop: inset.top + 4, paddingLeft: inset.left + 4, paddingRight: inset.right + 4 }]}>
        <IconButton icon="back" iconColor={stage.onStage} size={24} accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Text variant="titleSmall" numberOfLines={1} style={st.name}>{current?.meta?.name}</Text>
        <Text variant="labelMedium" style={st.count}>{t("{n} of {total}", { n: (Math.min(index, list.length - 1) + 1).toLocaleString(locale()), total: list.length.toLocaleString(locale()) })}</Text>
        <IconButton icon="info" iconColor={stage.onStage} size={24} accessibilityLabel={t("Details")} onPress={() => setInfo(true)} />
      </Animated.View>
      {current ? (
        <Animated.View pointerEvents={chrome ? "auto" : "none"} importantForAccessibility={chrome ? "auto" : "no-hide-descendants"}
          onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}
          style={[st.actions, { opacity: shown, paddingBottom: inset.bottom + 8, paddingLeft: inset.left, paddingRight: inset.right }]}>
          <Action icon="share" label={t("Share")} onPress={share} />
          <Action icon={isFav ? "heartOn" : "heart"} label={t("Favorite")} onPress={toggleFav} on={isFav} />
          <Action icon="folderPlus" label={t("Add to album")} onPress={() => setPicker(true)} />
          <Action icon="download" label={t("Save")} onPress={save} />
          <Action icon="trash" label={t("Trash")} onPress={trash} />
        </Animated.View>
      ) : null}
      {current ? <Info item={current} visible={info} onClose={() => setInfo(false)} /> : null}
      <Portal>
        <Dialog visible={!!busy} dismissable={false}>
          <Dialog.Content>
            <Text variant="bodyLarge" style={{ marginBottom: 12 }}>{busy?.label}…</Text>
            <ProgressBar progress={busy?.progress ?? 0} indeterminate={!busy?.progress} style={{ height: 5, borderRadius: 3 }} />
            <Text variant="bodySmall" style={{ marginTop: 12, opacity: 0.75 }}>{t("Photos are decrypted on this phone. Shared and saved copies are not encrypted.")}</Text>
          </Dialog.Content>
        </Dialog>
        <AlbumPicker visible={picker} onDismiss={() => setPicker(false)} onPick={intoAlbum} />
      </Portal>
      <Snackbar visible={!!note} onDismiss={() => setNote(null)} duration={5000} style={{ marginBottom: inset.bottom + 88 }}
        action={note?.undo ? { label: t("Undo"), onPress: () => { const u = note.undo!; setNote(null); u(); } } : undefined}>
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

interface PageProps {
  item: Item; width: number; height: number; inset: Insets; active: boolean; onZoom: (zoomed: boolean) => void;
  /** the bars shown; a tap on the photo toggles them (onTap), the video's controls set them (onChrome) */
  chrome: boolean; onTap: () => void; onChrome: (shown: boolean) => void;
  onLoading: (item: string, loading: boolean) => void;
}

function Page({ item, width, height, inset, active, onZoom, chrome, onTap, onChrome, onLoading }: PageProps) {
  const [uri, setUri] = useState<string>();
  // a video plays when its page is the one on screen; the player gets the item's key only for that
  const play = active && item.kind === "video" && !!item.itemKey && item.segment_count > 0;
  const [ready, setReady] = useState(false);
  // until the player says it has the first part of the video
  const [buffering, setBuffering] = useState(true);
  useEffect(() => {
    if (!play) { setReady(false); return; }
    N.videoSource(server(), item.id, item.itemKey!, item.size, item.segment_count);
    setBuffering(true);
    setReady(true);
  }, [play, item.id]);
  const [sharp, setSharp] = useState(false);
  const [failed, setFailed] = useState(false); // the thumbnail stays; the badge doesn't turn on for ever
  useEffect(() => {
    let live = true;
    if (item.has_preview) previewUri(item).then((u) => { if (live) { setUri(u); setSharp(true); } }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [item.id]);
  const loading = ready ? buffering : !sharp && !failed && !!item.has_preview;
  useEffect(() => { onLoading(item.id, loading); }, [loading]);
  useEffect(() => () => onLoading(item.id, false), [item.id]);
  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      {/* a tap before the sharp photo is there shows or hides the bars too; on the photo Zoomable takes it, as one tap
          may still become two. Neither holds the video: a tap on it is the player's (it would count twice) */}
      {!uri ? (
        <Pressable onPress={onTap} accessible={false} style={{ width, height }}>
          {item.has_thumb ? <ThumbView item={item.id} fit="contain" style={{ width, height }} accessibilityLabel={item.meta?.name} /> : null}
        </Pressable>
      ) : null}
      {uri ? (
        <Zoomable width={width} height={height} active={active && !ready} onZoom={onZoom} onTap={onTap}>
          <Image source={{ uri }} style={{ width, height }} contentFit="contain" cachePolicy="memory" accessibilityLabel={item.meta?.name} />
        </Zoomable>
      ) : null}
      {ready ? (
        // the whole page, like the still under it (same fit, so it lines up); the controls keep clear of the bars and
        // come and go with them: a tap on the video shows or hides both
        <VideoView item={item.id} controlsInset={[inset.top + 56, inset.bottom + 80]} controls={chrome}
          onControls={(e) => onChrome(e.nativeEvent.visible)} onBuffering={(e) => setBuffering(e.nativeEvent.buffering)}
          style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} />
      ) : null}
    </View>
  );
}

const MAX_ZOOM = 5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A photo that zooms like in the gallery app: double-tap for 2.5× there (again for all of it), or pinch up to 5×.
 *  While zoomed one finger moves it and the pager holds still; another page resets it. One tap is onTap (the bars). */
function Zoomable({ width, height, active, onZoom, onTap, children }: { width: number; height: number; active: boolean; onZoom: (zoomed: boolean) => void; onTap: () => void; children: React.ReactNode }) {
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const z = useRef({ scale: 1, x: 0, y: 0, mode: "", from: 0, dist: 0, startX: 0, startY: 0 }).current;
  const apply = (next: number, x: number, y: number, animate = false) => {
    const k = clamp(next, 1, MAX_ZOOM);
    const mx = (width * (k - 1)) / 2, my = (height * (k - 1)) / 2;
    z.scale = k; z.x = clamp(x, -mx, mx); z.y = clamp(y, -my, my);
    if (animate) {
      Animated.parallel([scale, tx, ty].map((v, i) => Animated.timing(v, { toValue: [z.scale, z.x, z.y][i], duration: 200, useNativeDriver: true }))).start();
    } else { scale.setValue(z.scale); tx.setValue(z.x); ty.setValue(z.y); }
    onZoom(z.scale > 1.01);
  };
  // the taps outlive renders; what they do is the current render's (its size, its onTap)
  const now = useRef({ single: onTap, double: (_: { x: number; y: number }) => {} });
  now.current.single = onTap;
  now.current.double = ({ x, y }) => {
    if (z.scale > 1.01) return apply(1, 0, 0, true);
    const k = 2.5;
    apply(k, (width / 2 - x) * (k - 1), (height / 2 - y) * (k - 1), true);
  };
  const [tapper] = useState(() => taps<{ x: number; y: number }>(() => now.current.single(), (at) => now.current.double(at)));
  useEffect(() => () => tapper.cancel(), []);
  useEffect(() => { tapper.cancel(); if (!active && z.scale !== 1) apply(1, 0, 0); }, [active]);
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
  const tap = (e: GestureResponderEvent) => tapper.tap({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
  return (
    <Animated.View {...pan.panHandlers} style={{ width, height, transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>
      <Pressable onPress={tap} accessible={false} style={{ width, height }}>{children}</Pressable>
    </Animated.View>
  );
}

function Info({ item, visible, onClose }: { item: Item; visible: boolean; onClose: () => void }) {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const m = item.meta;
  const rows: [string, string | undefined][] = [
    [t("Taken"), fmtWhen(when(item))],
    [t("File"), m?.name],
    [t("Size"), fmtSize(item.size) + (m?.width && m?.height ? ` · ${m.width} × ${m.height}` : "")],
    [t("Camera"), [m?.make, m?.model].filter(Boolean).join(" ") || undefined],
    [t("Place"), m?.gps ? `${m.gps.lat.toFixed(4)}, ${m.gps.lon.toFixed(4)}` : undefined],
  ];
  return (
    <Portal>
      <Modal visible={visible} onDismiss={onClose} contentContainerStyle={[st.sheet, { backgroundColor: th.colors.background, paddingBottom: inset.bottom + 24 }]} style={{ justifyContent: "flex-end" }}>
        <Text variant="headlineSmall" style={{ marginBottom: 16 }}>{t("Details")}</Text>
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <View key={k} style={st.row}>
            <Text variant="labelMedium" style={{ color: th.colors.onSurfaceVariant, width: 72 }}>{k}</Text>
            <Text variant="bodyMedium" style={{ flex: 1 }} selectable>{v}</Text>
          </View>
        ))}
        {visible ? <InPhoto item={item} onClose={onClose} /> : null}
        <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant, marginTop: 12 }}>{t("Only you can read these details. The server stores them encrypted.")}</Text>
      </Modal>
    </Portal>
  );
}

/** Who is in the photo: every face found in it, named or not (name one right here), and photos like it. */
function InPhoto({ item, onClose }: { item: Item; onClose: () => void }) {
  const th = useAppTheme();
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
          <Text variant="labelMedium" style={{ color: th.colors.onSurfaceVariant, width: 72, paddingTop: 10 }}>{t("People")}</Text>
          <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {faces.map((f) => <Face key={f.key} face={f} onPress={() => {
              const name = f.group?.person?.name;
              if (name && f.group) { onClose(); router.push({ pathname: "/person/[key]", params: { key: f.group.key } }); }
              else setNaming(f);
            }} />)}
          </View>
        </View>
      ) : null}
      {error ? <Text variant="bodySmall" style={{ color: th.colors.error }}>{error}</Text> : null}
      <Pressable onPress={() => { onClose(); router.push({ pathname: "/search", params: { similar: item.id } }); }} accessibilityRole="button" style={[st.row, { alignItems: "center" }]}>
        <Text variant="labelMedium" style={{ color: th.colors.onSurfaceVariant, width: 72 }}>{t("Search")}</Text>
        <Icon name="similar" size={20} color={th.colors.primary} />
        <Text variant="bodyMedium" style={{ color: th.colors.primary }}>{t("Photos like this one")}</Text>
      </Pressable>
      <NameDialog visible={!!naming} title={t("Who is this?")} action={t("Save")} initial="" onDismiss={() => setNaming(null)}
        onSubmit={async (n) => {
          const f = naming!;
          setNaming(null);
          try { await nameFace(f, n); setError(undefined); await load(); }
          catch (e) { setError(e instanceof Error ? t("Couldn't save the name: {why}", { why: e.message }) : t("Couldn't save the name.")); }
        }} />
    </View>
  );
}

function Face({ face, onPress }: { face: FaceInPhoto; onPress: () => void }) {
  const th = useAppTheme();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => { let live = true; faceUri(face.cover).then((u) => live && setUri(u), () => {}); return () => { live = false; }; }, [face.key]);
  const name = face.group?.person?.name ?? "";
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={name || t("Someone not named yet: add a name")} style={{ alignItems: "center", width: 64 }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, overflow: "hidden", backgroundColor: th.colors.surfaceVariant }}>
        {uri ? <Image source={{ uri }} style={{ width: 48, height: 48 }} cachePolicy="memory" /> : null}
      </View>
      <Text variant="labelSmall" numberOfLines={1} style={{ marginTop: 4, color: name ? th.colors.onSurface : th.colors.primary }}>{name || t("Add name")}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  black: { flex: 1, backgroundColor: stage.stage },
  bar: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", alignItems: "center", backgroundColor: stage.stageBar },
  name: { flex: 1, color: stage.onStage },
  count: { color: stage.stageMuted, marginRight: 4, fontVariant: ["tabular-nums"] },
  loading: { position: "absolute" },
  actions: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", justifyContent: "space-around", paddingTop: 8, backgroundColor: stage.stageBar },
  action: { flex: 1, maxWidth: 110, alignItems: "center", paddingVertical: 8, borderRadius: 12 },
  sheet: { marginTop: "auto", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 24 },
  row: { flexDirection: "row", gap: 12, paddingVertical: 8 },
});
