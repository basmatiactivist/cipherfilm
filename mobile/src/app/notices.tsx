// The notifications list behind the bell (NoticesButton.tsx): every notice the server shows this phone (notices.ts),
// newest first, each with where to look (Devices or Two-step sign-in) and Remove, which takes it down on every
// device. Opening the list marks them read here, so the bell's badge goes.
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Divider, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../icons";
import { useAppTheme } from "../ui";
import { noticeOpens, noticeText, type Notice } from "../notices";
import { dismissNotice, markAllRead, refreshNotices, useLastRead, useNotices } from "../noticesStore";
import { text } from "../tokens";
import { t } from "../i18n";

export default function Notices() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const list = useNotices();
  // what was unread when the list opened keeps its mark while it is open
  const [lastRead] = useState(useLastRead());
  useEffect(() => { refreshNotices().catch(() => {}).finally(markAllRead); }, []);
  useEffect(() => { markAllRead(); }, [list]);
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Notifications")} titleStyle={text.page} />
        {list.length > 1 ? <Button compact onPress={() => { for (const n of list) dismissNotice(n.id); }} style={{ marginRight: 8 }}>{t("Remove all")}</Button> : null}
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24, flexGrow: 1 }}>
        {list.length ? list.map((n, i) => (
          <View key={n.id}>
            {i ? <Divider /> : null}
            <Item n={n} unread={n.id > lastRead} />
          </View>
        )) : (
          <View style={st.empty}>
            <View style={[st.disc, { backgroundColor: th.colors.primaryContainer }]}><Icon name="bell" size={28} color={th.colors.primary} /></View>
            <Text variant="titleMedium" style={{ marginTop: 16 }}>{t("No notifications")}</Text>
            <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant, textAlign: "center", marginTop: 6 }}>
              {t("New sign-ins and changes to two-step sign-in show up here.")}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Item({ n, unread }: { n: Notice; unread: boolean }) {
  const th = useAppTheme();
  const open = noticeOpens(n.kind);
  return (
    <View style={st.item}>
      <View style={st.mark}>{unread ? <View style={[st.dot, { backgroundColor: th.colors.primary }]} accessibilityLabel={t("Unread")} /> : null}</View>
      <View style={{ flex: 1 }}>
        <Text variant="bodyMedium">{noticeText(n)}</Text>
        <View style={st.row}>
          {open === "devices" ? <Button compact onPress={() => router.push("/devices")}>{t("Review devices")}</Button>
            : open === "two-step" ? <Button compact onPress={() => router.push("/two-step")}>{t("Two-step sign-in")}</Button> : null}
          <Button compact onPress={() => dismissNotice(n.id)}>{t("Remove")}</Button>
        </View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  item: { flexDirection: "row", paddingVertical: 14, paddingRight: 16 },
  mark: { width: 32, alignItems: "center", paddingTop: 7 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 4, marginTop: 6 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  disc: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" },
});
