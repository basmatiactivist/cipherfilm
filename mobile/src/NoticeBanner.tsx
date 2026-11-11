// The notices of notices.ts at the top of the library: a new sign-in elsewhere, two-step sign-in turned off by an
// administrator, or the password used for a sign-in that wasn't finished (nothing to open here: the password is
// changed in the browser). Each shows until it is dismissed (on any device).
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Button, Text } from "react-native-paper";
import { noticeText } from "./notices";
import { dismissNotice, refreshNotices, useNotices } from "./noticesStore";
import { useAppTheme } from "./ui";
import { radius } from "./tokens";
import { t } from "./i18n";

export function NoticeBanner() {
  const th = useAppTheme();
  const list = useNotices();
  useEffect(() => { refreshNotices().catch(() => {}); }, []);
  if (!list.length) return null;
  return (
    <View>
      {list.slice(0, 3).map((n) => (
        <View key={n.id} accessibilityLiveRegion="polite" style={[st.box, { backgroundColor: th.colors.primaryContainer, borderColor: th.colors.outlineVariant }]}>
          <Text variant="bodyMedium" style={{ color: th.colors.onPrimaryContainer }}>{noticeText(n)}</Text>
          <View style={st.row}>
            {n.kind === "sign_in"
              ? <Button compact onPress={() => router.push("/devices")}>{t("Review devices")}</Button>
              : n.kind === "2fa_reset" ? <Button compact onPress={() => router.push("/two-step")}>{t("Two-step sign-in")}</Button> : null}
            <Button compact onPress={() => { dismissNotice(n.id); }}>{t("Dismiss")}</Button>
          </View>
        </View>
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  box: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: radius.card, borderWidth: 1 },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 4, marginTop: 4 },
});
