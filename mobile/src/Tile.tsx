import { memo, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { when, type Item } from "./library";
import { ThumbView } from "../modules/cf-native/src/CfNativeModule";
import { Icon } from "./icons";
import { useAppTheme } from "./ui";
import { radius, stage } from "./tokens";
import { locale, t } from "./i18n";

let fmtTaken: Intl.DateTimeFormat | undefined;
let fmtLocale = "";
const taken = (ms: number) => {
  if (!fmtTaken || fmtLocale !== locale()) { fmtLocale = locale(); fmtTaken = new Intl.DateTimeFormat(fmtLocale, { dateStyle: "medium", timeStyle: "short" }); }
  return fmtTaken.format(new Date(ms));
};

interface Props {
  item: Item;
  size: number;
  selecting: boolean;
  selected: boolean;
  onPress: (it: Item) => void;
  onLongPress: (it: Item) => void;
  /** its picture is on screen, or there is none to wait for (the gallery's first screen waits for these) */
  onShown?: (id: string) => void;
}

/** One square in the library grid: the decrypted thumbnail (native, by id: Thumbs.kt), or a plain-words tile if it can't be verified. In selection
 *  mode every tile shows a circle; a selected one shrinks into its cell with a filled check, as in Google Photos. */
export const Tile = memo(function Tile({ item, size, selecting, selected, onPress, onLongPress, onShown }: Props) {
  const th = useAppTheme();
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!item.has_thumb || item.broken || failed) onShown?.(item.id); }, [item.id, failed]);
  // what a screen reader says: the kind and when it was taken, like the gallery app (file names are often just numbers)
  const label = item.broken ? t("Couldn't be verified") : item.kind === "video" ? t("Video, {date}", { date: taken(when(item)) }) : t("Photo, {date}", { date: taken(when(item)) });
  const inset = selected ? Math.round(size * 0.09) : 0;
  return (
    <Pressable
      onPress={() => onPress(item)} onLongPress={() => onLongPress(item)} delayLongPress={300}
      accessibilityRole="imagebutton" accessibilityLabel={label} accessibilityState={selecting ? { selected } : undefined}
      style={{ width: size, height: size, backgroundColor: selected ? th.colors.primaryContainer : "transparent", borderRadius: radius.tile }}>
      {({ pressed }) => (
        <>
          <View style={[st.tile, { margin: inset, borderRadius: selected ? radius.card : radius.tile, backgroundColor: item.broken ? th.colors.errorContainer : th.colors.surfaceVariant, opacity: pressed && !selecting ? 0.85 : 1 }]}>
            {item.has_thumb && !item.broken ? <ThumbView item={item.id} style={StyleSheet.absoluteFill} onFailed={() => setFailed(true)} onShown={() => onShown?.(item.id)} /> : null}
            {item.broken || failed ? (
              <View style={st.center}><Text variant="labelSmall" style={{ color: item.broken ? th.colors.onErrorContainer : th.colors.onSurfaceVariant, textAlign: "center" }}>{item.broken ? t("Couldn't be verified") : t("No preview")}</Text></View>
            ) : null}
            {item.kind === "video" && !item.broken ? <View style={st.badge}><Icon name="video" size={16} color={stage.onBadge} /></View> : null}
          </View>
          {selecting ? (
            selected ? (
              <View style={[st.check, { backgroundColor: th.colors.primary, borderColor: th.colors.background }]}><Icon name="check" size={16} color={th.colors.onPrimary} /></View>
            ) : (
              <View style={[st.ring, { backgroundColor: th.cf.dot, borderColor: th.colors.primary }]} />
            )
          ) : null}
        </>
      )}
    </Pressable>
  );
});

const st = StyleSheet.create({
  tile: { flex: 1, overflow: "hidden" },
  center: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", padding: 6 },
  badge: { position: "absolute", right: 6, bottom: 6, width: 26, height: 26, borderRadius: 13, backgroundColor: stage.badge, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", left: 4, top: 4, width: 26, height: 26, borderRadius: 13, borderWidth: 2 },
  check: { position: "absolute", left: 4, top: 4, width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
