// The "On this day" row at the top of Photos: one card per earlier year (memories.ts). A card opens that year's
// photos in the viewer, swiping through only them.
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Text } from "react-native-paper";
import { ThumbView } from "../modules/cf-native/src/CfNativeModule";
import { Icon } from "./icons";
import type { Item } from "./library";
import { yearsAgo, type Memory } from "./memories";
import { setViewerList } from "./viewerList";
import { useAppTheme } from "./ui";
import { radius, space, text } from "./tokens";
import { locale, t, tn } from "./i18n";

const SIZE = 120;

export function MemoriesRow({ memories }: { memories: Memory<Item>[] }) {
  const th = useAppTheme();
  if (!memories.length) return null;
  const fmt = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" });
  const open = (m: Memory<Item>) => {
    setViewerList(m.items.map((i) => i.id));
    router.push({ pathname: "/photo/[id]", params: { id: m.items[0].id, within: "memory" } });
  };
  return (
    <View style={st.wrap}>
      <Text style={[text.heading, st.head]} accessibilityRole="header">{t("On this day")}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.row}>
        {memories.map((m) => {
          const date = fmt.format(new Date(m.date));
          const thumb = m.cover.has_thumb && !m.cover.broken ? m.cover.id : undefined;
          return (
            <Pressable key={m.year} onPress={() => open(m)} accessibilityRole="button" style={{ width: SIZE }}
              accessibilityLabel={`${yearsAgo(m.yearsAgo)}, ${date}, ${tn(m.total, "{n} item", "{n} items")}`}>
              {({ pressed }) => (
                <>
                  <View style={[st.cover, { backgroundColor: th.colors.surfaceVariant, opacity: pressed ? 0.85 : 1 }]}>
                    {thumb ? <ThumbView item={thumb} style={StyleSheet.absoluteFill} /> : <Icon name={m.cover.kind === "video" ? "video" : "photos"} size={28} color={th.colors.onSurfaceVariant} />}
                  </View>
                  <Text numberOfLines={1} style={[text.label, { marginTop: space.s2 }]}>{yearsAgo(m.yearsAgo)}</Text>
                  <Text numberOfLines={1} variant="bodySmall" style={{ color: th.colors.onSurfaceVariant }}>{date}</Text>
                </>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { paddingTop: space.s2, paddingBottom: space.s1 },
  head: { paddingHorizontal: space.s1, paddingBottom: space.s2 },
  row: { gap: space.s3, paddingHorizontal: space.s1 },
  cover: { width: SIZE, height: SIZE, borderRadius: radius.card, overflow: "hidden", alignItems: "center", justifyContent: "center" },
});
