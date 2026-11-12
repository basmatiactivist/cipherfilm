// The notices of notices.ts at the top of the library: a new sign-in elsewhere, two-step sign-in turned off by an
// administrator or changed on another device (both open Two-step sign-in), or the password used for a sign-in that
// wasn't finished (nothing to open here: the password is changed in the browser). Each shows until it is dismissed (on any device). Always one banner, however many there
// are (noticeSummary): a stack of them pushed the photos far down.
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Button, Text } from "react-native-paper";
import { noticeSummary } from "./notices";
import { dismissNotice, refreshNotices, useNotices } from "./noticesStore";
import { useAppTheme } from "./ui";
import { radius } from "./tokens";
import { t } from "./i18n";

export function NoticeBanner() {
  const th = useAppTheme();
  const list = useNotices();
  useEffect(() => { refreshNotices().catch(() => {}); }, []);
  const s = noticeSummary(list);
  if (!s) return null;
  return (
    <View accessibilityLiveRegion="polite" style={[st.box, { backgroundColor: th.colors.primaryContainer, borderColor: th.colors.outlineVariant }]}>
      <Text variant="bodyMedium" style={{ color: th.colors.onPrimaryContainer }}>{s.text}</Text>
      <View style={st.row}>
        {s.open === "devices"
          ? <Button compact onPress={() => router.push("/devices")}>{t("Review devices")}</Button>
          : s.open === "two-step" ? <Button compact onPress={() => router.push("/two-step")}>{t("Two-step sign-in")}</Button> : null}
        <Button compact onPress={() => { for (const id of s.ids) dismissNotice(id); }}>{s.many ? t("Dismiss all") : t("Dismiss")}</Button>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  box: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: radius.card, borderWidth: 1 },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 4, marginTop: 4 },
});
