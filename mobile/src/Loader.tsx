// The loading badge, the same as the web's (web/src/loader.tsx) and the Mac's: the mark ("Photo lock") on a round seal
// whose outer edge is the loading ring, a teal arc turning around it. The large one also seals the mark: tiles pass
// over the photo, then the shackle closes. With reduced motion the ring only fades in and out.
// Geometry on the 48 grid; the moving parts are views over a still drawing, so the native driver animates them.
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, type ViewStyle } from "react-native";
import { Text } from "react-native-paper";
import Svg, { Circle, G, Path } from "react-native-svg";
import { useAppTheme } from "./ui";
import { loader, motion, stage as stageColors } from "./tokens";

const SHACKLE = "M6.6 10V7A5.4 5.4 0 0 1 17.4 7V10H14.4V7A2.4 2.4 0 0 0 9.6 7V10Z";
const BODY = "M5.8 9.4H18.2A2.2 2.2 0 0 1 20.4 11.6V19.8A2.2 2.2 0 0 1 18.2 22H5.8A2.2 2.2 0 0 1 3.6 19.8V11.6A2.2 2.2 0 0 1 5.8 9.4ZM6.2 19.8L6.2 18L10.2 13.6L13.6 17.2L17.8 14.4L17.8 19.8ZM13.7 12.6A1.7 1.7 0 1 0 17.1 12.6A1.7 1.7 0 1 0 13.7 12.6Z";
/** The mark on the 48 grid: half the badge tall on the large one, a little more on the small one. */
const MARK = { large: { x: 9.6, y: 9.84, k: 1.2 }, small: { x: 8.4, y: 8.66, k: 1.3 } };
/** Tiles over the photo body (x 3.6 to 20.4, y 9.4 to 22 on the 24 grid): 4 by 3, swept corner to corner. */
const CELLS = Array.from({ length: 12 }, (_, i) => ({ c: i % 4, r: Math.floor(i / 4) }));

/** Whether the system asks for less motion, kept current. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduced(v), () => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { alive = false; sub.remove(); };
  }, []);
  return reduced;
}

const loop = (v: Animated.Value, ms: number) =>
  Animated.loop(Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true }));

/** The badge alone, as decoration next to words that say what is happening (a busy button, a status row).
 *  On its own use `Loading`, which labels it for screen readers. */
export function Loader({ large, style }: { large?: boolean; style?: ViewStyle }) {
  const t = useAppTheme();
  const reduced = useReducedMotion();
  const size = large ? loader.large : loader.small;
  const u = size / 48; // one grid unit in dp
  const w = large ? 2.5 : 5; // the ring is thicker on the small badge, so it still reads at 20 dp
  const r = 24 - w / 2;
  const m = large ? MARK.large : MARK.small;
  const turn = useRef(new Animated.Value(0)).current;
  const seal = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const runs = reduced
      ? [Animated.loop(Animated.sequence([
          Animated.timing(breathe, { toValue: 1, duration: motion.breathe, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(breathe, { toValue: 0, duration: motion.breathe, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]))]
      : [loop(turn, motion.turn), ...(large ? [loop(seal, motion.seal)] : [])];
    runs.forEach((a) => a.start());
    return () => runs.forEach((a) => a.stop());
  }, [reduced, large]);

  const track = t.dark ? t.cf.ruleStrong : t.cf.rule;
  const ring = (dash: boolean) => (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Circle cx={24} cy={24} r={r} stroke={t.cf.teal} strokeWidth={w} fill="none" strokeLinecap="round"
        {...(dash ? { strokeDasharray: [0.26 * 2 * Math.PI * r, 2 * Math.PI * r] } : {})} />
    </Svg>
  );
  // the shackle open, closing once the tiles have passed, then open again for the next loop (as on the web)
  const lift = seal.interpolate({ inputRange: [0, 0.46, 0.56, 0.6, 0.86, 1], outputRange: [-1.7, -1.7, 0.25, 0, 0, -1.7].map((y) => y * m.k * u) });

  return (
    <View style={[{ width: size, height: size }, style]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Svg width={size} height={size} viewBox="0 0 48 48" style={StyleSheet.absoluteFill}>
        <Circle cx={24} cy={24} r={24} fill={t.cf.card} />
        <Circle cx={24} cy={24} r={r} stroke={track} strokeWidth={w} fill="none" />
        <G transform={`translate(${m.x} ${m.y}) scale(${m.k})`}><Path d={BODY} fill={t.cf.teal} fillRule="evenodd" /></G>
      </Svg>
      {large && !reduced ? CELLS.map(({ c, r: row }) => {
        // each tile glints in the badge's own color, later the further it is from the top left corner
        const d = ((c + row) * 100) / motion.seal;
        const opacity = seal.interpolate({ inputRange: [0, d + 0.0001, d + 0.08, d + 0.26, 1.3], outputRange: [0, 0, 0.5, 0, 0], extrapolate: "clamp" });
        const at = (v: number) => v * m.k * u;
        return <Animated.View key={c + row * 4} style={{ position: "absolute", left: at(3.6 + c * 4.2) + m.x * u, top: at(9.4 + row * 4.2) + m.y * u, width: at(4.2), height: at(4.2), backgroundColor: t.cf.card, opacity }} />;
      }) : null}
      <Animated.View style={[StyleSheet.absoluteFill, large && !reduced ? { transform: [{ translateY: lift }] } : null]}>
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <G transform={`translate(${m.x} ${m.y}) scale(${m.k})`}><Path d={SHACKLE} fill={t.cf.teal} /></G>
        </Svg>
      </Animated.View>
      {reduced ? (
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }]}>{ring(false)}</Animated.View>
      ) : (
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["-90deg", "270deg"] }) }] }]}>{ring(true)}</Animated.View>
      )}
    </View>
  );
}

/** For a Paper Button's `icon` while it works: `icon={busy ? busyIcon : undefined}`, in place of `loading`. */
export const busyIcon = () => <Loader />;

/** Something is loading: the large badge with what is happening, centred where the content will be. `inline` is the
 *  small badge in a row; `stage` is for the black photo viewer. Fades in after a moment, so a quick load doesn't flash. */
export function Loading({ label = "Loading…", inline, stage, style }: { label?: string; inline?: boolean; stage?: boolean; style?: ViewStyle }) {
  const t = useAppTheme();
  const reduced = useReducedMotion();
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(fade, { toValue: 1, duration: motion.medium, delay: reduced ? 0 : 200, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, []);
  const color = stage ? stageColors.onStage : t.colors.onSurfaceVariant;
  return (
    <Animated.View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityLiveRegion="polite"
      style={[inline ? s.inline : s.block, { opacity: fade }, style]}>
      <Loader large={!inline} />
      <Text variant={inline ? "bodyMedium" : "bodyLarge"} style={[inline ? s.inlineText : s.blockText, { color }]}>{label}</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  block: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 64, paddingHorizontal: 24, gap: 16 },
  blockText: { textAlign: "center", maxWidth: 320 },
  inline: { flexDirection: "row", alignItems: "center", gap: 12 },
  inlineText: { flexShrink: 1 },
});
