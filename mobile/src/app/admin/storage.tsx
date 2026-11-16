// Administration › Storage and backup: what the server stores in all (and its disk), and per account how much it takes
// of what kind and when each of its devices last uploaded (server/storage.go). Sizes, counts, device labels and times
// only: an administrator still sees nobody's photos or names. The public demo account's devices are never listed.
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Divider, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Problem, useAppTheme } from "../../ui";
import { useAction } from "../../useAction";
import { useSession } from "../../session";
import { text } from "../../tokens";
import { t } from "../../i18n";
import { isAdmin, loadStorage, noAccess, size } from "../../admin";
import { diskShare, type ServerStorage, staleSummary, totalLine } from "../../storage";
import { StorageView, UsageBar } from "../../StorageView";

export default function AdminStorage() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { me } = useSession();
  const [data, setData] = useState<ServerStorage | null>(null);
  const [refused, setRefused] = useState(!isAdmin(me));
  const page = useAction();
  const load = () => page.run(async () => {
    try { setData(await loadStorage()); } catch (e) { if (noAccess(e)) { setRefused(true); return; } throw e; }
  });
  useEffect(() => { if (isAdmin(me)) load(); }, []);

  const disk = data ? diskShare(data) : null;
  const muted = { color: th.colors.onSurfaceVariant };
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Storage and backup")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }}>
        <View style={st.block}>
          {refused ? <Text variant="bodyMedium">{t("Only administrators of this server can see this.")}</Text> : null}
          <Problem>{page.error}</Problem>
          {data ? (<>
            <Text variant="bodyMedium">{totalLine(data)}</Text>
            {disk !== null ? (<>
              <Text variant="bodyMedium" style={{ marginTop: 12, marginBottom: 8 }}>{t("Disk free: {free} of {total}", { free: size(data.disk_free_bytes), total: size(data.disk_total_bytes) })}</Text>
              <UsageBar share={disk} />
            </>) : null}
            <Text variant="bodySmall" style={[muted, { marginTop: 12 }]}>{t("Sizes, item counts and when each device last uploaded. Nobody's photos or names.")}</Text>
            <Problem>{staleSummary(data.stale_devices)}</Problem>
          </>) : null}
        </View>
        {(data?.accounts ?? []).map((a) => (
          <View key={a.id}>
            <Divider />
            <View style={st.block}>
              <Text variant="titleSmall" numberOfLines={2}>{a.email + (a.id === me?.user.id ? " " + t("(you)") : "")}</Text>
              <Text variant="bodySmall" style={[muted, { marginBottom: 8 }]}>{[a.role === "admin" ? t("admin") : t("user"), a.status === "active" ? "" : t("disabled")].filter(Boolean).join(", ")}</Text>
              <StorageView a={a} />
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingVertical: 16 },
});
