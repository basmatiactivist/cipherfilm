import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Easing, PanResponder, Pressable, StatusBar, StyleSheet, useWindowDimensions, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { Button, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { yearRecap } from "@memories/recap";
import { ThumbView } from "../../../../modules/cf-native/src/CfNativeModule";
import { Icon, type IconName } from "../../../icons";
import { previewUri, type Item } from "../../../library";
import { refreshLibrary, useLibrary } from "../../../libraryStore";
import { Loading } from "../../../Loader";
import { faceUri, usePeople, type Group } from "../../../search/people";
import { slideItems, slideMs, storySlides, type Slide } from "../../../recapStory";
import { tripTitle, usePlaceLookup, useTrips } from "../../../trips";
import { setViewerList } from "../../../viewerList";
import { dark } from "../../../tokens";
import { locale, t, tn } from "../../../i18n";

const WHITE = "#ffffff";
const SOFT = "rgba(255,255,255,0.78)";
const ZOOM = 1.06;

/** The year in review as a story: one picture at a time, full screen, bars on top that fill as it plays. Tap on the
 *  right for the next, on the left for the one before, hold to pause, swipe down to close (recapStory.ts has the
 *  slides). With reduced motion or a screen reader it doesn't play on its own and shows Back and Next instead. */
export default function RecapStory() {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const year = Number(useLocalSearchParams<{ year: string }>().year);
  const { items } = useLibrary();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  const lookup = usePlaceLookup();
  const { groups } = usePeople();
  const named = useMemo(() => (groups ?? []).filter((g) => g.person?.name && !g.person.hidden), [groups]);
  const tripsAll = useTrips(items);
  const slides = useMemo(() => {
    if (!items) return null;
    const r = yearRecap(items, year, { lookup: lookup ?? undefined, people: named });
    if (!r) return [];
    const trips = (tripsAll ?? []).filter((x) => new Date(x.start).getFullYear() === year || new Date(x.end).getFullYear() === year)
      .map((x) => ({ key: x.key, title: tripTitle(x), start: x.start, items: x.items }));
    return storySlides(r, trips, new Set(named.map((g) => g.key)));
  }, [items, year, lookup, named, tripsAll]);
  const people = useMemo(() => new Map(named.map((g) => [g.key, g])), [named]);

  // manual: reduced motion or a screen reader; then nothing moves or plays on its own
  const [manual, setManual] = useState<boolean | null>(null);
  useEffect(() => {
    Promise.all([AccessibilityInfo.isReduceMotionEnabled(), AccessibilityInfo.isScreenReaderEnabled()])
      .then(([a, b]) => setManual(a || b), () => setManual(false));
  }, []);

  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false); // the person paused (the button, or Open)
  const held = useRef(false); // a finger is down
  const away = useRef(false); // the app is in the background or another screen is on top
  const progress = useRef(new Animated.Value(0)).current;
  const at = useRef(0); // progress of the current slide when it was stopped
  const anim = useRef<Animated.CompositeAnimation | null>(null);
  const count = slides?.length ?? 0;
  const slide = slides?.[Math.min(i, Math.max(0, count - 1))];
  const last = i >= count - 1;

  const go = useCallback((to: number) => {
    if (!count) return;
    const n = Math.max(0, Math.min(count - 1, to));
    anim.current?.stop(); at.current = 0; progress.setValue(0);
    setI(n);
  }, [count]);

  const stop = () => { anim.current?.stop(); anim.current = null; progress.stopAnimation((v) => { at.current = v; }); };
  const play = () => {
    if (!slide || manual !== false || paused || held.current || away.current) return;
    if (last) { progress.setValue(1); return; } // the end slide stays
    const ms = slideMs(slide) * (1 - at.current);
    anim.current = Animated.timing(progress, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true });
    anim.current.start(({ finished }) => { if (finished) go(i + 1); });
  };
  const playing = useRef(play); playing.current = play;
  const stopping = useRef(stop); stopping.current = stop;
  // (re)start whenever the slide or what holds it changes; stopping keeps how far it got
  useEffect(() => { play(); return () => stop(); }, [i, slide, manual, paused]);
  // in manual mode nothing plays: a month shows its first photo (Open shows them all)
  useEffect(() => { if (manual) progress.setValue(0); }, [manual, i]);

  // the app in the background, or another screen on top (the viewer, a person): it waits
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      away.current = s !== "active";
      if (away.current) stopping.current(); else playing.current();
    });
    return () => sub.remove();
  }, []);
  useFocusEffect(useCallback(() => {
    if (away.current) { away.current = false; playing.current(); }
    return () => { away.current = true; stopping.current(); };
  }, []));

  // preload the next pictures
  useEffect(() => {
    const next = slides?.[i + 1];
    if (next) for (const it of slideItems(next)) if (it.has_preview && !it.broken) previewUri(it).catch(() => {});
  }, [i, slides]);

  const close = () => (router.canGoBack() ? router.back() : router.replace("/library"));
  const open = (list: Item[], k: number) => {
    // it waits while the viewer is on top (useFocusEffect) and goes on when back
    setViewerList(list.map((x) => x.id));
    router.push({ pathname: "/photo/[id]", params: { id: list[k].id, within: "memory" } });
  };

  // taps, holding and swiping down, on the picture (the buttons sit above it)
  const down = useRef({ t: 0, dy: 0 });
  const touch = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { down.current = { t: Date.now(), dy: 0 }; held.current = true; stop(); },
    onPanResponderMove: (_, g) => { down.current.dy = g.dy; },
    onPanResponderRelease: (e, g) => {
      held.current = false;
      if (g.dy > 90 && Math.abs(g.dy) > Math.abs(g.dx)) { close(); return; }
      const tap = Date.now() - down.current.t < 250 && Math.abs(g.dx) < 12 && Math.abs(g.dy) < 12;
      if (tap) go(e.nativeEvent.pageX < width / 3 ? i - 1 : i + 1);
      else play();
    },
    onPanResponderTerminate: () => { held.current = false; play(); },
  }), [i, width, count, slide, manual, paused]);

  if (!slides || manual === null) return <View style={[st.fill, { backgroundColor: "#000" }]}><Loading label={t("Opening your library…")} /></View>;
  if (!slide) {
    return (
      <View style={[st.fill, st.center, { backgroundColor: dark.paper, padding: 32 }]}>
        <Text style={[st.serif, { fontSize: 22, color: WHITE, textAlign: "center" }]}>{t("No photos from {year}.", { year })}</Text>
        <Button mode="text" textColor={WHITE} onPress={close} style={{ marginTop: 16 }}>{t("Close")}</Button>
      </View>
    );
  }

  const monthName = new Intl.DateTimeFormat(locale(), { month: "long" });
  const zoom = manual ? 1 : progress.interpolate({ inputRange: [0, 1], outputRange: [1, ZOOM] });
  const photos = slideItems(slide);
  const describe = describeSlide(slide, year, monthName, people);

  return (
    <View style={[st.fill, { backgroundColor: "#000" }]} accessibilityViewIsModal accessibilityLabel={t("{year} in review", { year })}>
      <StatusBar hidden />
      {/* the picture, or the dark page of a slide without one */}
      <View style={StyleSheet.absoluteFill} {...touch.panHandlers} accessible accessibilityLabel={describe} accessibilityLiveRegion="polite">
        {photos.length ? (
          <Animated.View key={i} style={[StyleSheet.absoluteFill, { transform: [{ scale: zoom }] }]}>
            {photos.map((it, k) => (
              <Animated.View key={it.id} style={[StyleSheet.absoluteFill, k === 0 || manual ? null : {
                opacity: progress.interpolate({ inputRange: [Math.max(0, k / photos.length - 0.05), k / photos.length, 1], outputRange: [0, 1, 1], extrapolate: "clamp" }),
              }, manual && k > 0 ? { opacity: 0 } : null]}>
                <Picture item={it} />
              </Animated.View>
            ))}
          </Animated.View>
        ) : <View style={[StyleSheet.absoluteFill, { backgroundColor: dark.paper }]} />}
        {photos.length ? <Scrim height={height} /> : null}
      </View>

      {/* bars and buttons on top */}
      <View style={[st.top, { paddingTop: inset.top + 8, paddingLeft: inset.left + 12, paddingRight: inset.right + 12 }]} pointerEvents="box-none">
        <View style={st.bars} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {slides.map((s, k) => (
            <View key={k} style={st.bar}>
              {k < i ? <View style={[StyleSheet.absoluteFill, st.barFill]} /> : k === i ? (
                <Animated.View style={[StyleSheet.absoluteFill, st.barFill, { transformOrigin: "left", transform: [{ scaleX: last || manual ? 1 : progress }] }]} />
              ) : null}
            </View>
          ))}
        </View>
        <View style={st.row} pointerEvents="box-none">
          <Text style={[st.serif, { fontSize: 18, color: WHITE }]} accessibilityRole="header">{String(year)}</Text>
          <View style={st.row}>
            {!manual && !last ? <Round icon={paused ? "play" : "pause"} label={paused ? t("Play") : t("Pause")} onPress={() => setPaused((p) => !p)} /> : null}
            <Round icon="x" label={t("Close")} onPress={close} />
          </View>
        </View>
      </View>

      {/* what the slide says */}
      <View style={[st.bottom, { paddingBottom: inset.bottom + 20, paddingLeft: inset.left + 24, paddingRight: inset.right + 24 }]} pointerEvents="box-none">
        <SlideText slide={slide} year={year} monthName={monthName} people={people}
          onPerson={(key) => { router.push({ pathname: "/person/[key]", params: { key } }); }}
          again={() => { setPaused(false); go(0); }} all={() => router.replace({ pathname: "/recap/[year]", params: { year: String(year) } })} close={close} />
        {photos.length || manual ? (
          <View style={[st.row, { marginTop: 16 }]} pointerEvents="box-none">
            {manual ? <Round icon="back" label={t("Previous")} onPress={() => go(i - 1)} disabled={i === 0} /> : <View />}
            <View style={st.row}>
              {photos.length ? <Button mode="contained-tonal" compact buttonColor="rgba(255,255,255,0.18)" textColor={WHITE} onPress={() => open(photos, 0)} accessibilityHint={t("Opens the photo")}>{t("Open")}</Button> : null}
              {manual && !last ? <Round icon="forward" label={t("Next")} onPress={() => go(i + 1)} /> : null}
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The thumbnail at once, the sharp preview over it when it has loaded. */
function Picture({ item }: { item: Item }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (item.has_preview && !item.broken) previewUri(item).then((u) => live && setUri(u), () => {});
    return () => { live = false; };
  }, [item.id]);
  return (
    <>
      {item.has_thumb && !item.broken ? <ThumbView item={item.id} style={StyleSheet.absoluteFill} /> : <View style={[StyleSheet.absoluteFill, { backgroundColor: dark.paperDeep }]} />}
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory" transition={250} /> : null}
    </>
  );
}

/** Dark at the top and bottom, so white text reads on any photo. */
function Scrim({ height }: { height: number }) {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id="top" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#000" stopOpacity={0.55} /><Stop offset="1" stopColor="#000" stopOpacity={0} />
        </LinearGradient>
        <LinearGradient id="bottom" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#000" stopOpacity={0} /><Stop offset="1" stopColor="#000" stopOpacity={0.7} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height={160} fill="url(#top)" />
      <Rect x="0" y={height * 0.55} width="100%" height={height * 0.45} fill="url(#bottom)" />
    </Svg>
  );
}

function Round({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}
      style={({ pressed }) => [st.round, { opacity: disabled ? 0.35 : pressed ? 0.7 : 1 }]}>
      <Icon name={icon} size={22} color={WHITE} />
    </Pressable>
  );
}

function SlideText({ slide, year, monthName, people, onPerson, again, all, close }: {
  slide: Slide<Item>; year: number; monthName: Intl.DateTimeFormat; people: Map<string, Group>;
  onPerson: (key: string) => void; again: () => void; all: () => void; close: () => void;
}) {
  switch (slide.kind) {
    case "cover":
      return (
        <View>
          <Text style={[st.serif, { fontSize: 76, lineHeight: 82, color: WHITE }]}>{String(year)}</Text>
          <Text style={[st.serif, { fontSize: 22, lineHeight: 28, color: WHITE, marginTop: 4 }]}>{t("Your year in pictures")}</Text>
        </View>
      );
    case "month":
      return (
        <View>
          <Text style={[st.serif, { fontSize: 40, lineHeight: 46, color: WHITE }]}>{cap(monthName.format(new Date(year, slide.month, 1)))}</Text>
          <Text style={[st.caption, { color: SOFT }]}>{tn(slide.total, "{n} item", "{n} items")}</Text>
        </View>
      );
    case "trip":
      return (
        <View>
          <Text style={[st.caption, { color: SOFT, marginBottom: 4 }]}>{t("Trip")}</Text>
          <Text style={[st.serif, { fontSize: 32, lineHeight: 38, color: WHITE }]}>{slide.title}</Text>
          <Text style={[st.caption, { color: SOFT }]}>{tn(slide.count, "{n} item", "{n} items")}</Text>
        </View>
      );
    case "places":
      return (
        <View>
          <Text style={[st.caption, { color: SOFT, marginBottom: 4 }]}>{t("Where you were most")}</Text>
          <Text style={[st.serif, { fontSize: 34, lineHeight: 40, color: WHITE }]}>{slide.top.name}</Text>
          <Text style={[st.caption, { color: SOFT }]}>{slide.top.country}</Text>
          {slide.others.length ? <Text style={[st.caption, { color: SOFT, marginTop: 12 }]}>{t("Also: {places}", { places: slide.others.join(" · ") })}</Text> : null}
        </View>
      );
    case "people":
      return (
        <View style={{ marginBottom: "40%" }}>
          <Text style={[st.serif, { fontSize: 32, lineHeight: 38, color: WHITE, marginBottom: 24 }]}>{t("With you this year")}</Text>
          <View style={st.faces}>
            {slide.people.map((p) => { const g = people.get(p.key); return g ? <StoryFace key={p.key} group={g} count={p.count} onPress={() => onPerson(p.key)} /> : null; })}
          </View>
        </View>
      );
    case "end":
      return (
        <View style={{ marginBottom: "30%" }}>
          <Text style={[st.serif, { fontSize: 40, lineHeight: 46, color: WHITE, marginBottom: 28 }]}>{t("That was {year}", { year })}</Text>
          <Button mode="contained" onPress={again} contentStyle={{ height: 48 }} buttonColor={dark.teal} textColor={dark.onTeal}>{t("Watch again")}</Button>
          <Button mode="outlined" onPress={all} contentStyle={{ height: 48 }} textColor={WHITE} style={{ marginTop: 12, borderColor: "rgba(255,255,255,0.4)" }}>{t("All highlights")}</Button>
          <Button mode="text" onPress={close} contentStyle={{ height: 48 }} textColor={SOFT} style={{ marginTop: 4 }}>{t("Close")}</Button>
        </View>
      );
  }
}

function StoryFace({ group, count, onPress }: { group: Group; count: number; onPress: () => void }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (group.cover) faceUri(group.cover).then((u) => live && setUri(u), () => {});
    return () => { live = false; };
  }, [group.cover?.key]);
  const name = group.person?.name ?? "";
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tn(count, "{name}, {n} photo", "{name}, {n} photos", { name })} style={({ pressed }) => [st.face, { opacity: pressed ? 0.8 : 1 }]}>
      <View style={st.faceDisc}>
        {uri ? <Image source={{ uri }} style={{ width: 84, height: 84 }} cachePolicy="memory" transition={150} /> : <Icon name="user" size={34} color={SOFT} />}
      </View>
      <Text numberOfLines={1} style={[st.label, { color: WHITE, marginTop: 8 }]}>{name}</Text>
      <Text style={[st.small, { color: SOFT }]}>{tn(count, "{n} photo", "{n} photos")}</Text>
    </Pressable>
  );
}

/** What a screen reader says for a slide. */
function describeSlide(s: Slide<Item>, year: number, month: Intl.DateTimeFormat, people: Map<string, Group>): string {
  switch (s.kind) {
    case "cover": return `${t("{year} in review", { year })}. ${t("Your year in pictures")}`;
    case "month": return `${cap(month.format(new Date(year, s.month, 1)))} ${year}, ${tn(s.total, "{n} item", "{n} items")}`;
    case "trip": return `${t("Trip")}: ${s.title}, ${tn(s.count, "{n} item", "{n} items")}`;
    case "places": return `${t("Where you were most")}: ${s.top.name}, ${s.top.country}`;
    case "people": return `${t("With you this year")}: ${s.people.map((p) => people.get(p.key)?.person?.name).filter(Boolean).join(", ")}`;
    case "end": return t("That was {year}", { year });
  }
}

const cap = (s: string) => s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1);

const st = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  serif: { fontFamily: "serif", fontWeight: "400" },
  caption: { fontSize: 15, lineHeight: 20 },
  label: { fontSize: 14, lineHeight: 18, fontWeight: "600" },
  small: { fontSize: 12, lineHeight: 15 },
  top: { position: "absolute", left: 0, right: 0, top: 0, gap: 10 },
  bars: { flexDirection: "row", gap: 4 },
  bar: { flex: 1, height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.32)", overflow: "hidden" },
  barFill: { backgroundColor: WHITE },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0 },
  faces: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  face: { width: 96, alignItems: "center" },
  faceDisc: { width: 84, height: 84, borderRadius: 42, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.12)" },
});
