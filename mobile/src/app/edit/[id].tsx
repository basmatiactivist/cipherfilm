// The editor (docs/EDITING.md): turn and crop a photo, change when and where it was taken (videos: only those two).
// Nothing changes until Save; the original always stays as it was, and "Revert to original" brings everything back.
import { useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, ScrollView, StyleSheet, useColorScheme, useWindowDimensions, View } from "react-native";
import { router, useLocalSearchParams, useNavigation, usePreventRemove } from "expo-router";
import { Image } from "expo-image";
import { Button, IconButton, List, Portal, ProgressBar, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Camera, Map as MapView, ViewAnnotation } from "@maplibre/maplibre-react-native";
import { dragCrop, isEdited, normEdit, normOrig, ratioRect, reverted, turn, turnedSize, withDate, withPlace, type Edit, type Gps, type Handle, type Rect } from "@edit/edit";
import { previewUri, type ItemMeta } from "../../library";
import { libraryItems, refreshLibrary } from "../../libraryStore";
import { canEdit, canEditPicture, closeOriginal, dateParts, openOriginal, parseDateTime, saveEdit, upright, type Opened, type Upright } from "../../edit";
import { loadPlaces, localLabel, localPlace, type Place } from "../../places";
import { Field, Problem, useAppTheme, Dialog, useKeyboardHeight } from "../../ui";
import { stage } from "../../tokens";
import { t } from "../../i18n";
import { useSession } from "../../session";
import { mapCacheReady, useMapOn } from "../../mapConsent";

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const WORK_PX = 1600;
const RATIOS: { label: string; name: string; r: number | null | "orig" }[] = [
  { label: "Free", name: "Free shape", r: null },
  { label: "Original", name: "Shape of the photo", r: "orig" },
  { label: "Square", name: "Square", r: 1 },
  { label: "4:3", name: "4 by 3", r: 4 / 3 },
  { label: "3:4", name: "3 by 4", r: 3 / 4 },
  { label: "16:9", name: "16 by 9", r: 16 / 9 },
  { label: "9:16", name: "9 by 16", r: 9 / 16 },
];
const HANDLES: Handle[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];
const placeLine = (p: Place) => [p.name, p.region !== p.name ? p.region : "", p.country].filter(Boolean).join(", ");

export default function EditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [it] = useState(() => libraryItems().find((i) => i.id === id));
  const meta = it?.meta;
  const pictureTools = !!it && canEditPicture(it);

  const [edit, setEdit] = useState<Edit | undefined>(meta?.edit);
  const [ratio, setRatio] = useState<number | null | "orig">(null);
  const [ts, setTs] = useState(meta?.capture_ts ?? 0);
  const [dateText, setDateText] = useState(() => dateParts(meta?.capture_ts ?? 0));
  const [gps, setGps] = useState<Gps | null>(meta?.gps ?? null);
  const [touched, setTouched] = useState({ date: false, place: false, revert: false });
  const [opened, setOpened] = useState<Opened | null>(null);
  const [work, setWork] = useState<Upright | null>(null);
  const [still, setStill] = useState<string>();
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState<{ label: string; progress: number } | null>(null);
  const [err, setErr] = useState("");

  // photos: the original, decrypted on this phone (the saved pictures are drawn from it); videos: their still
  useEffect(() => {
    if (!it) return;
    let alive = true, o: Opened | null = null;
    if (pictureTools) {
      openOriginal(it).then(async (got) => {
        o = got;
        if (!alive) { closeOriginal(got); return; }
        setOpened(got);
        const w = await upright(got, WORK_PX);
        if (alive) setWork(w);
      }).catch(() => alive && setLoadErr(t("This photo couldn't be opened for editing on this phone. You can still change its date and place.")));
    } else if (it.has_preview) previewUri(it).then((u) => alive && setStill(u), () => {});
    return () => { alive = false; closeOriginal(o); };
  }, []);

  const rot = normEdit(edit)?.rot ?? 0;
  const crop = edit?.crop ?? FULL;
  const pic = work ? turnedSize(work.width, work.height, rot) : { w: 1, h: 1 };
  const shape = (r: typeof ratio) => (r === "orig" ? pic.w / pic.h : r);
  // the picture as large as fits the top of the screen
  const boxW = width - 32, boxH = Math.max(200, height * 0.5);
  const fit = Math.min(boxW / pic.w, boxH / pic.h);
  const dispW = pic.w * fit, dispH = pic.h * fit;

  const setCrop = (r: Rect) => setEdit((e) => normEdit({ ...e, crop: r, v: undefined }));
  const rotate = (by: 90 | -90) => setEdit((e) => {
    let next = turn(e, by);
    const r = shape(ratio);
    if (r && work) {
      const tz = turnedSize(work.width, work.height, next?.rot ?? 0);
      next = normEdit({ ...next, crop: ratioRect(r, tz.w, tz.h, next?.crop) });
    }
    return next;
  });
  const chooseRatio = (r: typeof ratio) => {
    setRatio(r);
    const s = shape(r);
    if (s) setCrop(ratioRect(s, pic.w, pic.h, edit?.crop));
  };

  // dragging: what the gesture started from, read by the responders (they live across renders)
  const now = useRef({ crop, dispW, dispH, ratio: shape(ratio), aspect: pic.w / pic.h });
  now.current = { crop, dispW, dispH, ratio: shape(ratio), aspect: pic.w / pic.h };
  // the page doesn't scroll while the frame is dragged (Android's scroll view would take the gesture over)
  const [dragging, setDragging] = useState(false);
  const responders = useMemo(() => Object.fromEntries((["move", ...HANDLES] as Handle[]).map((h) => {
    let start = FULL;
    return [h, PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { start = now.current.crop; setDragging(true); },
      onPanResponderMove: (_, g) => { const n = now.current; setCrop(dragCrop(start, h, g.dx / n.dispW, g.dy / n.dispH, n.ratio, n.aspect)); },
      onPanResponderRelease: () => setDragging(false),
      onPanResponderTerminate: () => setDragging(false),
      onPanResponderTerminationRequest: () => false,
    })];
  })) as Record<Handle, ReturnType<typeof PanResponder.create>>, []);

  // the place: its name, places found by name, a spot picked on the map
  const [placeName, setPlaceName] = useState("");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Place[]>([]);
  const [picking, setPicking] = useState(false);
  const mapOn = useMapOn();
  useEffect(() => {
    let alive = true;
    setPlaceName("");
    if (gps) loadPlaces().then((p) => alive && setPlaceName(localLabel(p, p.nearest(gps.lat, gps.lon))), () => {});
    return () => { alive = false; };
  }, [gps?.lat, gps?.lon]);
  useEffect(() => {
    let alive = true;
    if (query.trim().length < 2) { setFound([]); return; }
    const tm = setTimeout(() => loadPlaces().then((p) => alive && setFound(p.find(query, 8).map((f) => localPlace(p, f))), () => {}), 150);
    return () => { alive = false; clearTimeout(tm); };
  }, [query]);
  const place = (g: Gps | null) => { setGps(g); setTouched((x) => ({ ...x, place: true })); setQuery(""); setFound([]); };

  const orig = normOrig(meta?.orig);
  const revert = () => {
    setEdit(undefined);
    setRatio(null);
    const back = orig && "capture_ts" in orig ? orig.capture_ts! : ts;
    setTs(back); setDateText(dateParts(back));
    if (orig && "gps" in orig) setGps(orig.gps ?? null);
    setTouched({ date: false, place: false, revert: true });
  };
  const typedDate = parseDateTime(dateText.date, dateText.time, ts);

  const next = useMemo((): ItemMeta | null => {
    if (!meta) return null;
    let m: ItemMeta = touched.revert ? reverted(meta) : meta;
    if (touched.date && typedDate !== null && typedDate !== m.capture_ts) m = withDate(m, typedDate);
    if (touched.place) m = withPlace(m, gps);
    const e = normEdit(edit);
    m = { ...m };
    if (e) m.edit = e; else delete m.edit;
    return m;
  }, [edit, typedDate, gps, touched]);
  const changed = !!next && JSON.stringify(next) !== JSON.stringify(meta);

  // leaving with changes not saved (Cancel, Android's back): asked first; saving leaves without asking
  const [saved, setSaved] = useState(false);
  const [discard, setDiscard] = useState<null | (() => void)>(null);
  const navigation = useNavigation();
  // Discard: the guard goes first, the screen leaves once that has rendered (else the guard would stop it again)
  const [leaveWith, setLeaveWith] = useState<null | { action: unknown }>(null);
  usePreventRemove(changed && !saved && !leaveWith, ({ data }) => setDiscard(() => () => setLeaveWith({ action: data.action })));
  useEffect(() => { if (leaveWith) navigation.dispatch(leaveWith.action as never); }, [leaveWith]);

  // the place search's suggestions come below its field: while typing there, the page shows them above the keyboard
  const kb = useKeyboardHeight();
  const scroller = useRef<{ scrollTo: (o: { y: number; animated?: boolean }) => void } | null>(null);
  const formY = useRef(0), placeY = useRef(0);
  const [placeFocused, setPlaceFocused] = useState(false);
  // the "Place" heading at the top of the screen: the field and its suggestions below it, above the keyboard
  useEffect(() => {
    if (placeFocused && kb) { const id = setTimeout(() => scroller.current?.scrollTo({ y: Math.max(0, formY.current + placeY.current - 8), animated: true }), 50); return () => clearTimeout(id); }
  }, [placeFocused, kb]);

  const save = async () => {
    if (!it || !next) return;
    setErr("");
    setBusy({ label: t("Saving"), progress: 0 });
    try {
      await saveEdit(it, next, (label, progress) => setBusy({ label, progress }), opened);
      await refreshLibrary({ quiet: true }).catch(() => {});
      setSaved(true);
      setTimeout(() => router.back(), 0); // once the screen knows it may go
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("Couldn't save the changes."));
    } finally {
      setBusy(null);
    }
  };

  if (!it || !meta || !canEdit(it)) {
    return (
      <View style={[st.fill, { backgroundColor: stage.stage, paddingTop: inset.top }]}>
        <IconButton icon="x" iconColor={stage.onStage} accessibilityLabel={t("Close")} onPress={() => router.back()} />
        <Text style={{ color: stage.onStage, padding: 24 }}>{t("This item can't be edited.")}</Text>
      </View>
    );
  }

  return (
    <View style={[st.fill, { backgroundColor: th.colors.background }]}>
      <View style={[st.bar, { paddingTop: inset.top + 4, paddingLeft: inset.left + 4, paddingRight: inset.right + 8 }]}>
        <IconButton icon="x" iconColor={stage.onStage} accessibilityLabel={t("Cancel")} onPress={() => router.back()} disabled={!!busy} />
        <Text variant="titleMedium" style={st.title} numberOfLines={1}>{t("Edit")}</Text>
        <Button mode="contained" onPress={save} disabled={!changed || !!busy || (touched.date && typedDate === null)}>{t("Save")}</Button>
      </View>
      <ScrollView ref={scroller as never} scrollEnabled={!dragging} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: inset.bottom + 32 + kb }}>
        <View style={[st.stage, { minHeight: boxH + 32 }]}>
          {pictureTools && work ? (
            <View style={{ width: dispW, height: dispH, overflow: "hidden" }}>
              {/* the upright picture, turned around its centre; the box has the turned size */}
              <Image source={{ uri: work.uri }} contentFit="fill" cachePolicy="none" accessibilityIgnoresInvertColors
                style={{ position: "absolute", width: work.width * fit, height: work.height * fit, left: (dispW - work.width * fit) / 2, top: (dispH - work.height * fit) / 2, transform: [{ rotate: `${rot}deg` }] }} />
              <Shade crop={crop} />
              <View {...responders.move.panHandlers} accessible accessibilityLabel={t("Crop frame")}
                style={[st.frame, { left: crop.x * dispW, top: crop.y * dispH, width: crop.w * dispW, height: crop.h * dispH }]}>
                {HANDLES.map((h) => <View key={h} {...responders[h].panHandlers} hitSlop={12} style={[st.grip, gripAt(h)]} />)}
              </View>
            </View>
          ) : pictureTools && !loadErr ? (
            <View style={{ alignItems: "center", gap: 12 }}>
              <ProgressBar indeterminate color={stage.onStage} style={{ width: 160 }} />
              <Text style={{ color: stage.stageMuted }}>{t("Decrypting the original…")}</Text>
            </View>
          ) : still ? (
            <Image source={{ uri: still }} style={{ width: boxW, height: boxH }} contentFit="contain" cachePolicy="memory" accessibilityLabel={meta.name} />
          ) : null}
        </View>
        {pictureTools && work ? (
          <View style={st.tools}>
            <View style={st.turns}>
              <IconButton icon="turnLeft" iconColor={stage.onStage} accessibilityLabel={t("Turn left")} onPress={() => rotate(-90)} />
              <IconButton icon="turnRight" iconColor={stage.onStage} accessibilityLabel={t("Turn right")} onPress={() => rotate(90)} />
              <Button mode="text" textColor={stage.onStage} disabled={!edit?.crop} onPress={() => { setRatio(null); setEdit((e) => normEdit({ ...e, crop: undefined })); }}>{t("No crop")}</Button>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.ratios}>
              {RATIOS.map((r) => (
                <Button key={r.label} compact mode={ratio === r.r ? "contained-tonal" : "outlined"} textColor={ratio === r.r ? undefined : stage.onStage} onPress={() => chooseRatio(r.r)}
                  accessibilityLabel={t(r.name)} accessibilityState={{ selected: ratio === r.r }}>{t(r.label)}</Button>
              ))}
            </ScrollView>
          </View>
        ) : null}
        <View style={st.form} onLayout={(e) => { formY.current = e.nativeEvent.layout.y; }}>
          {loadErr ? <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant, marginBottom: 12 }}>{loadErr}</Text> : null}
          {it.kind === "video" ? <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant, marginBottom: 12 }}>{t("For videos you can change the date and the place.")}</Text> : null}
          <Text variant="titleSmall" style={st.head}>{t("Taken")}</Text>
          <View style={st.row}>
            <View style={{ flex: 3 }}>
              <Field label={t("Date")} value={dateText.date} placeholder="2024-05-01" keyboardType="numbers-and-punctuation"
                onChangeText={(v) => { setDateText((d) => ({ ...d, date: v })); setTouched((x) => ({ ...x, date: true })); }} />
            </View>
            <View style={{ flex: 2 }}>
              <Field label={t("Time")} value={dateText.time} placeholder="14:30" keyboardType="numbers-and-punctuation"
                onChangeText={(v) => { setDateText((d) => ({ ...d, time: v })); setTouched((x) => ({ ...x, date: true })); }} />
            </View>
          </View>
          {touched.date && typedDate === null ? <Text variant="bodySmall" style={{ color: th.colors.error, marginTop: -4, marginBottom: 8 }}>{t("Type the date as year-month-day and the time as hours:minutes.")}</Text> : null}

          <Text variant="titleSmall" style={st.head} onLayout={(e) => { placeY.current = e.nativeEvent.layout.y; }}>{t("Place")}</Text>
          <Text variant="bodyLarge" style={{ marginBottom: 8 }}>{gps ? (placeName || `${gps.lat.toFixed(4)}, ${gps.lon.toFixed(4)}`) : t("No place")}</Text>
          <Field label={t("Search for a town or city")} value={query} onChangeText={setQuery} autoCapitalize="words"
            onFocus={() => setPlaceFocused(true)} onBlur={() => setPlaceFocused(false)} />
          {found.map((f, i) => (
            <List.Item key={i} title={placeLine(f)} titleNumberOfLines={2} onPress={() => place({ lat: f.lat, lon: f.lon })} left={(p) => <List.Icon {...p} icon="map" />} />
          ))}
          {query.trim().length >= 2 && !found.length ? <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant }}>{t("No place of that name. Towns of 1,000 people and more are known.")}</Text> : null}
          <View style={[st.row, { flexWrap: "wrap", marginTop: 8 }]}>
            {mapOn ? <Button mode={picking ? "contained-tonal" : "outlined"} icon="map" onPress={() => setPicking((v) => !v)}>{t("Pick on the map")}</Button> : null}
            {gps ? <Button mode="outlined" textColor={th.colors.error} onPress={() => place(null)}>{t("Remove place")}</Button> : null}
          </View>
          {picking ? <PickMap at={gps} onPick={(g) => place(g)} /> : null}

          <Problem>{err}</Problem>
          {isEdited(meta) || touched.revert ? (
            <Button mode="text" onPress={revert} disabled={touched.revert} style={{ alignSelf: "flex-start", marginTop: 16 }}>
              {touched.revert ? t("Reverted: save to keep it") : t("Revert to original")}
            </Button>
          ) : null}
          <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant, marginTop: 12 }}>{t("The original stays as it was. The changes are encrypted on this phone like the rest of the photo's details.")}</Text>
        </View>
      </ScrollView>
      <Portal>
        <Dialog visible={!!discard} onDismiss={() => setDiscard(null)}>
          <Dialog.Title>{t("Discard your changes?")}</Dialog.Title>
          <Dialog.Content><Text variant="bodyMedium">{t("What you changed here isn't saved.")}</Text></Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDiscard(null)}>{t("Keep editing")}</Button>
            <Button textColor={th.colors.error} onPress={() => { const go = discard; setDiscard(null); go?.(); }}>{t("Discard")}</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={!!busy} dismissable={false}>
          <Dialog.Content>
            <Text variant="bodyLarge" style={{ marginBottom: 12 }}>{busy?.label}…</Text>
            <ProgressBar progress={busy?.progress ?? 0} indeterminate={!busy?.progress} style={{ height: 5, borderRadius: 3 }} />
          </Dialog.Content>
        </Dialog>
      </Portal>
    </View>
  );
}

/** Darkens what the crop leaves out: four bands around the frame. */
function Shade({ crop }: { crop: Rect }) {
  const pct = (v: number) => `${v * 100}%` as const;
  return (
    <>
      <View pointerEvents="none" style={[st.shade, { left: 0, right: 0, top: 0, height: pct(crop.y) }]} />
      <View pointerEvents="none" style={[st.shade, { left: 0, right: 0, top: pct(crop.y + crop.h), bottom: 0 }]} />
      <View pointerEvents="none" style={[st.shade, { left: 0, width: pct(crop.x), top: pct(crop.y), height: pct(crop.h) }]} />
      <View pointerEvents="none" style={[st.shade, { left: pct(crop.x + crop.w), right: 0, top: pct(crop.y), height: pct(crop.h) }]} />
    </>
  );
}

const G = 24;
function gripAt(h: Handle) {
  const x = h.includes("w") ? 0 : h.includes("e") ? 1 : 0.5, y = h.includes("n") ? 0 : h.includes("s") ? 1 : 0.5;
  return { left: `${x * 100}%`, top: `${y * 100}%`, marginLeft: -G / 2, marginTop: -G / 2 } as const;
}

/** A tap on the map puts the photo's place there; opens where it is now, or on the whole world. Only once the person
 *  turned the map on (useMapOn), like every map in the app. */
function PickMap({ at, onPick }: { at: Gps | null; onPick: (g: Gps) => void }) {
  const th = useAppTheme();
  const scheme = useColorScheme();
  const conf = useSession().me?.map;
  const [styleAt, setStyleAt] = useState(0);
  const [cacheOk, setCacheOk] = useState(false);
  const [pin, setPin] = useState(at);
  useEffect(() => { mapCacheReady().then(() => setCacheOk(true)); }, []);
  if (!conf || !cacheOk) return null;
  const styles = scheme === "dark" || th.dark ? conf.dark : conf.light;
  return (
    <View style={[st.pickmap, { borderColor: th.colors.outlineVariant }]} accessible accessibilityLabel={t("Map: tap where the photo was taken")}>
      <MapView style={StyleSheet.absoluteFill} mapStyle={styles[styleAt]} logo={false} compass={false} touchRotate={false} touchPitch={false}
        attribution attributionPosition={{ bottom: 4, right: 4 }}
        onDidFailLoadingMap={() => { if (styleAt + 1 < styles.length) setStyleAt(styleAt + 1); }}
        onPress={(e) => { const [lon, lat] = e.nativeEvent.lngLat; const g = { lat, lon }; setPin(g); onPick(g); }}>
        <Camera initialViewState={at ? { center: [at.lon, at.lat], zoom: 11 } : { center: [10, 15], zoom: 0 }} />
        {pin ? (
          <ViewAnnotation id="here" lngLat={[pin.lon, pin.lat]} anchor="center">
            <View style={[st.pin, { backgroundColor: th.colors.primary, borderColor: th.colors.surface }]} />
          </ViewAnnotation>
        ) : null}
      </MapView>
    </View>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1 },
  bar: { flexDirection: "row", alignItems: "center", backgroundColor: stage.stage, paddingBottom: 4 },
  title: { flex: 1, color: stage.onStage },
  stage: { backgroundColor: stage.stage, alignItems: "center", justifyContent: "center", padding: 16 },
  frame: { position: "absolute", borderWidth: 1, borderColor: stage.onStage },
  grip: { position: "absolute", width: G, height: G, borderRadius: G / 2, backgroundColor: stage.onStage, borderWidth: 2, borderColor: stage.stage },
  shade: { position: "absolute", backgroundColor: stage.badge },
  tools: { backgroundColor: stage.stage, paddingBottom: 8 },
  turns: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  ratios: { gap: 8, paddingHorizontal: 16 },
  form: { padding: 16 },
  head: { marginTop: 16, marginBottom: 8 },
  row: { flexDirection: "row", gap: 12 },
  pickmap: { height: 260, marginTop: 12, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  pin: { width: 18, height: 18, borderRadius: 9, borderWidth: 3 },
});
