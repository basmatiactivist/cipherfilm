// The bell next to Account: opens the notifications list (app/notices.tsx), with a badge counting the notices this
// phone hasn't shown in that list yet (noticesStore.ts). It loads them when it first appears, as the banner did.
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Badge } from "react-native-paper";
import { unreadCount } from "./notices";
import { refreshNotices, useLastRead, useNotices } from "./noticesStore";
import { useAppTheme } from "./ui";
import { t, tn } from "./i18n";

export function NoticesButton() {
  const th = useAppTheme();
  const list = useNotices();
  const n = unreadCount(list, useLastRead());
  useEffect(() => { refreshNotices().catch(() => {}); }, []);
  const label = n ? tn(n, "Notifications, {n} unread", "Notifications, {n} unread") : t("Notifications");
  return (
    <View>
      <Appbar.Action icon="bell" accessibilityLabel={label} onPress={() => router.push("/notices")} />
      {n ? (
        <Badge size={18} style={[st.badge, { backgroundColor: th.colors.primary, color: th.colors.onPrimary }]}
          accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{n > 9 ? "9+" : n}</Badge>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({ badge: { position: "absolute", top: 6, right: 4 } });
