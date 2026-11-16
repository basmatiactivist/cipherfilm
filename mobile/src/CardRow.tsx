// A row of photo cards that scrolls sideways, like "On this day" (MemoriesRow.tsx): the year recaps on Photos, the
// suggested trips in Albums, the places in a recap.
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { ThumbView } from "../modules/cf-native/src/CfNativeModule";
import { Icon } from "./icons";
import type { Item } from "./library";
import { useAppTheme } from "./ui";
import { radius, space, text } from "./tokens";

export interface Card { key: string; cover?: Item; title: string; sub?: string; label?: string; onPress?: () => void }

export function CardRow({ title, note, cards, size = 120 }: { title: string; note?: ReactNode; cards: Card[]; size?: number }) {
  const th = useAppTheme();
  if (!cards.length) return null;
  return (
    <View style={st.wrap}>
      <Text style={[text.heading, st.head]} accessibilityRole="header">{title}</Text>
      {note ? <Text variant="bodySmall" style={[st.note, { color: th.colors.onSurfaceVariant }]}>{note}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.row}>
        {cards.map((c) => {
          const thumb = c.cover?.has_thumb && !c.cover.broken ? c.cover.id : undefined;
          return (
            <Pressable key={c.key} onPress={c.onPress} disabled={!c.onPress} accessibilityRole={c.onPress ? "button" : undefined} style={{ width: size }}
              accessibilityLabel={c.label ?? [c.title, c.sub].filter(Boolean).join(", ")}>
              {({ pressed }) => (
                <>
                  <View style={[st.cover, { width: size, height: size, backgroundColor: th.colors.surfaceVariant, opacity: pressed ? 0.85 : 1 }]}>
                    {thumb ? <ThumbView item={thumb} style={StyleSheet.absoluteFill} /> : <Icon name={c.cover?.kind === "video" ? "video" : "photos"} size={28} color={th.colors.onSurfaceVariant} />}
                  </View>
                  <Text numberOfLines={2} style={[text.label, { marginTop: space.s2 }]}>{c.title}</Text>
                  {c.sub ? <Text numberOfLines={1} variant="bodySmall" style={{ color: th.colors.onSurfaceVariant }}>{c.sub}</Text> : null}
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
  note: { paddingHorizontal: space.s1, paddingBottom: space.s2 },
  row: { gap: space.s3, paddingHorizontal: space.s1 },
  cover: { borderRadius: radius.card, overflow: "hidden", alignItems: "center", justifyContent: "center" },
});
