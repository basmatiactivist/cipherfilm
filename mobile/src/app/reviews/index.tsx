// Account › Memories › Custom reviews: searches saved to play as a story once a day, week or month, with different
// photos each time (reviews.ts). Synced with the account's other devices, end-to-end encrypted.
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Divider, List, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MAX_REVIEWS } from "@memories/custom";
import { dueLabel, everyLabel, useReviews } from "../../reviews";
import { Problem, useAppTheme } from "../../ui";
import { Icon } from "../../icons";
import { Loading } from "../../Loader";
import { text } from "../../tokens";
import { t, tn } from "../../i18n";

export default function Reviews() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { doc, shown, needsModel, error } = useReviews();
  const full = doc.reviews.length >= MAX_REVIEWS;
  const add = () => router.push("/reviews/edit");
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Custom reviews")} titleStyle={text.page} />
        {shown?.length && !full ? <Appbar.Action icon="plus" accessibilityLabel={t("New review")} onPress={add} /> : null}
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }}>
        <View style={st.block}>
          <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant }}>
            {t("A search you save plays as a story, daily, weekly or monthly, with different photos each time. Synced with your other devices, end-to-end encrypted: the server never learns what a review is about.")}
          </Text>
          <Problem>{error}</Problem>
          {needsModel ? (
            <View style={{ marginTop: 12 }}>
              <Text variant="bodyMedium">{t("Custom reviews need search set up on this phone.")}</Text>
              <Button mode="text" compact onPress={() => router.push("/search-settings")} style={{ alignSelf: "flex-start", marginTop: 4 }}>{t("Search and people")}</Button>
            </View>
          ) : null}
        </View>
        <Divider />
        {shown === null ? <Loading inline /> : shown.length ? (
          <>
            {shown.map((r) => (
              <List.Item key={r.id} title={r.name} titleNumberOfLines={2} descriptionNumberOfLines={3} style={st.item}
                description={`${everyLabel(r.every)} · ${tn(r.count, "{n} photo", "{n} photos")}\n${dueLabel(r, doc)}`}
                left={() => <View style={st.icon}><Icon name="sparkle" color={th.colors.primary} /></View>}
                onPress={() => router.push({ pathname: "/reviews/edit", params: { id: r.id } })} accessibilityHint={t("Edit review")}
                right={() => (
                  <Button compact onPress={() => router.push({ pathname: "/review/[id]", params: { id: r.id } })} accessibilityLabel={t("Watch {name}", { name: r.name })}>{t("Watch")}</Button>
                )} />
            ))}
            {full ? <Text variant="bodySmall" style={[st.block, { color: th.colors.onSurfaceVariant }]}>{t("You can have at most {n} custom reviews.", { n: MAX_REVIEWS })}</Text> : null}
          </>
        ) : needsModel ? null : (
          <View style={st.empty}>
            <View style={[st.disc, { backgroundColor: th.colors.primaryContainer }]}><Icon name="sparkle" size={30} color={th.colors.primary} /></View>
            <Text variant="titleMedium" style={{ textAlign: "center", marginBottom: 8 }}>{t("No custom reviews yet")}</Text>
            <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, maxWidth: 320 }}>
              {t("For example a weekly look at your dog, or a monthly one of a city you love.")}
            </Text>
            <Button mode="contained" icon="plus" onPress={add} style={{ marginTop: 20 }} contentStyle={{ height: 48 }}>{t("New review")}</Button>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingVertical: 16 },
  item: { minHeight: 64, paddingHorizontal: 8 },
  icon: { width: 40, alignItems: "center", justifyContent: "center", marginLeft: 8 },
  empty: { alignItems: "center", padding: 32 },
  disc: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", marginBottom: 16 },
});
