// Administration › Activity: the server's audit log as sentences, grouped by day (the web's Admin › Activity).
// Metadata only: who did what to which account, never anything about photos.
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, List, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Problem, useAppTheme } from "../../ui";
import { Icon } from "../../icons";
import { useAction } from "../../useAction";
import { useSession } from "../../session";
import { text } from "../../tokens";
import { locale, t } from "../../i18n";
import { type AuditEntry, byDay, describe, isAdmin, loadAudit, noAccess } from "../../admin";

export default function AdminActivity() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { me } = useSession();
  const [list, setList] = useState<AuditEntry[] | null>(null);
  const [refused, setRefused] = useState(!isAdmin(me));
  const page = useAction();
  useEffect(() => {
    if (isAdmin(me)) page.run(async () => {
      try { setList(await loadAudit()); } catch (e) { if (noAccess(e)) { setRefused(true); return; } throw e; }
    });
  }, []);
  const time = (sec: number) => new Date(sec * 1000).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Activity")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }}>
        <View style={st.block}>
          {refused ? <Text variant="bodyMedium">{t("Only administrators of this server can see this.")}</Text> : null}
          {list && list.length === 0 ? <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant }}>{t("Nothing yet. Invites, role and limit changes, and removals show up here.")}</Text> : null}
          <Problem>{page.error}</Problem>
        </View>
        {byDay(list ?? []).map(([day, entries]) => (
          <View key={day}>
            <List.Subheader accessibilityRole="header">{day}</List.Subheader>
            {entries.map((a, i) => {
              const d = describe(a, me?.user.email ?? "");
              const color = d.warn ? th.colors.error : th.colors.onSurfaceVariant;
              return (
                <List.Item key={i} title={d.text} titleNumberOfLines={4} description={time(a.at)} style={st.item}
                  left={() => <View style={st.icon}><Icon name={d.icon} color={color} size={20} /></View>} />
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingTop: 16 },
  item: { minHeight: 48, paddingHorizontal: 8 },
  icon: { width: 40, alignItems: "center", justifyContent: "center", marginLeft: 8 },
});
