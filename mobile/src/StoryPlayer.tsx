// The story player: one slide at a time, full screen, bars on top that fill as it plays. Tap on the right for the next,
// on the left for the one before, hold to pause, swipe down to close. With reduced motion or a screen reader it doesn't
// play on its own and shows Back and Next instead. It plays any list of slides: the year in review
// (app/recap/story/[year].tsx, recapStory.ts) and the custom reviews (app/review/[id].tsx, reviewStory.ts); what a
// slide says is the caller's.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, AppState, Easing, PanResponder, Pressable, StatusBar, StyleSheet, useWindowDimensions, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Image } from "expo-image";
import { Button, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { ThumbView } from "../modules/cf-native/src/CfNativeModule";
import { Icon, type IconName } from "./icons";
import { previewUri, type Item } from "./library";
import { Loading } from "./Loader";
import { setViewerList } from "./viewerList";
import { dark } from "./tokens";
import { locale, t } from "./i18n";

export const WHITE = "#ffffff";
export const SOFT = "rgba(255,255,255,0.78)";
const ZOOM = 1.06;

/** What a slide's words can do: play from the start again, close the story. */
export interface StoryControls { again: () => void; close: () => void }

export interface StoryProps<S> {
  /** null while loading; empty: nothing to show (emptyText) */
  slides: S[] | null;
  /** at the top left */
  title: string;
  /** what a screen reader calls the whole story */
  label: string;
  emptyText: string;
  /** how long a slide stays */
  ms: (s: S) => number;
  /** the photos a slide shows (several fade in one after the other while it plays) */
  items: (s: S) => Item[];
  /** what a screen reader says for a slide */
  describe: (s: S) => string;
  /** the slide's words, at the bottom */
  text: (s: S, c: StoryControls) => ReactNode;
}

export function StoryPlayer<S>({ slides, title, label, emptyText, ms, items, describe, text }: StoryProps<S>) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

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
    const d = ms(slide) * (1 - at.current);
    anim.current = Animated.timing(progress, { toValue: 1, duration: d, easing: Easing.linear, useNativeDriver: true });
    anim.current.start(({ finished }) => { if (finished) go(i + 1); });
  };
  const playing = useRef(play); playing.current = play;
  const stopping = useRef(stop); stopping.current = stop;
  // (re)start whenever the slide or what holds it changes; stopping keeps how far it got
  useEffect(() => { play(); return () => stop(); }, [i, slide, manual, paused]);
  // in manual mode nothing plays: a slide of several photos shows its first (Open shows them all)
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
    if (next) for (const it of items(next)) if (it.has_preview && !it.broken) previewUri(it).catch(() => {});
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

  if (!slides || manual === null) return <View style={[storyStyles.fill, { backgroundColor: "#000" }]}><Loading label={t("Opening your library…")} /></View>;
  if (!slide) {
    return (
      <View style={[storyStyles.fill, storyStyles.center, { backgroundColor: dark.paper, padding: 32 }]}>
        <Text style={[storyStyles.serif, { fontSize: 22, color: WHITE, textAlign: "center" }]}>{emptyText}</Text>
        <Button mode="text" textColor={WHITE} onPress={close} style={{ marginTop: 16 }}>{t("Close")}</Button>
      </View>
    );
  }

  const zoom = manual ? 1 : progress.interpolate({ inputRange: [0, 1], outputRange: [1, ZOOM] });
  const photos = items(slide);
  const st = storyStyles;

  return (
    <View style={[st.fill, { backgroundColor: "#000" }]} accessibilityViewIsModal accessibilityLabel={label}>
      <StatusBar hidden />
      {/* the picture, or the dark page of a slide without one */}
      <View style={StyleSheet.absoluteFill} {...touch.panHandlers} accessible accessibilityLabel={describe(slide)} accessibilityLiveRegion="polite">
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
          <Text numberOfLines={1} style={[st.serif, { fontSize: 18, color: WHITE, flexShrink: 1 }]} accessibilityRole="header">{title}</Text>
          <View style={st.row}>
            {!manual && !last ? <Round icon={paused ? "play" : "pause"} label={paused ? t("Play") : t("Pause")} onPress={() => setPaused((p) => !p)} /> : null}
            <Round icon="x" label={t("Close")} onPress={close} />
          </View>
        </View>
      </View>

      {/* what the slide says */}
      <View style={[st.bottom, { paddingBottom: inset.bottom + 20, paddingLeft: inset.left + 24, paddingRight: inset.right + 24 }]} pointerEvents="box-none">
        {text(slide, { again: () => { setPaused(false); go(0); }, close })}
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
      style={({ pressed }) => [storyStyles.round, { opacity: disabled ? 0.35 : pressed ? 0.7 : 1 }]}>
      <Icon name={icon} size={22} color={WHITE} />
    </Pressable>
  );
}

export const cap = (s: string) => s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1);

export const storyStyles = StyleSheet.create({
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
});
