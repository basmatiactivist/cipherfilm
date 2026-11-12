// Administration › Server: the server's own state (disk, data, signed-in devices, version, uptime, the off-site
// backup as the operator's backup tool reported it) and the storage limit new people get (the web's Server and Defaults).
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Divider, List, Portal, ProgressBar, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field, Problem, useAppTheme, Dialog } from "../../ui";
import { Icon } from "../../icons";
import { busyIcon } from "../../Loader";
import { useAction } from "../../useAction";
import { useSession } from "../../session";
import { text } from "../../tokens";
import { locale, t } from "../../i18n";
import { backupState, isAdmin, limitText, loadAccounts, loadStatus, noAccess, gbField, limitToSave, type ServerStatus, setDefaultLimit, size, uptime } from "../../admin";

export default function AdminServer() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { me } = useSession();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [def, setDef] = useState<number | null>(null);
  const [refused, setRefused] = useState(!isAdmin(me));
  const page = useAction();
  const load = () => page.run(async () => {
    try {
      const [s, a] = await Promise.all([loadStatus(), loadAccounts()]);
      setStatus(s); setDef(a.default_quota_bytes);
    } catch (e) { if (noAccess(e)) { setRefused(true); return; } throw e; }
  });
  useEffect(() => { if (isAdmin(me)) load(); }, []);

  const [editing, setEditing] = useState(false);
  const [gb, setGb] = useState("");
  const act = useAction();
  const close = () => { if (!act.busy) { setEditing(false); act.setError(undefined); } };
  const save = () => act.run(async () => { await setDefaultLimit(limitToSave(gb, gbField(def ?? 0), def ?? 0)); setEditing(false); await load(); });

  const backup = status ? backupState(status) : null;
  const used = status && status.disk_total_bytes > 0 ? (status.disk_total_bytes - status.disk_free_bytes) / status.disk_total_bytes : null;
  const fact = (title: string, value: string, bad = false) => (
    <List.Item title={title} description={value} descriptionNumberOfLines={5} style={st.item}
      descriptionStyle={bad ? { color: th.colors.error, fontWeight: "600" } : undefined} />
  );
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Server")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }}>
        <View style={st.block}>
          {refused ? <Text variant="bodyMedium">{t("Only administrators of this server can see this.")}</Text> : null}
          <Problem>{page.error}</Problem>
          {used !== null && status ? (<>
            <Text variant="bodyMedium" style={{ marginBottom: 8 }}>{t("Disk: {used} of {total} used", { used: size(status.disk_total_bytes - status.disk_free_bytes), total: size(status.disk_total_bytes) })}</Text>
            <ProgressBar progress={Math.min(1, used)} color={used > 0.9 ? th.colors.error : th.colors.primary} style={{ height: 5, borderRadius: 3, backgroundColor: th.colors.outlineVariant }} />
          </>) : null}
        </View>
        {def !== null ? (<>
          <Divider />
          <List.Item title={t("Default storage limit")} titleNumberOfLines={2} descriptionNumberOfLines={4}
            description={t("New people get {limit} unless the invite says otherwise. People who already joined keep their limit.", { limit: limitText(def) })}
            left={() => <View style={st.icon}><Icon name="cloud" color={th.colors.primary} /></View>}
            right={() => <Button compact onPress={() => { setGb(gbField(def)); setEditing(true); }}>{t("Change")}</Button>} style={st.item} />
        </>) : null}
        {status ? (<>
          <Divider />
          {fact(t("Disk free"), t("{free} of {total}", { free: size(status.disk_free_bytes), total: size(status.disk_total_bytes) }))}
          {fact(t("Cipherfilm data"), size(status.data_bytes))}
          {fact(t("Signed-in devices"), String(status.active_sessions))}
          {fact(t("Version"), status.version ?? t("Unknown"))}
          {fact(t("Running for"), uptime(status.uptime_seconds))}
          {fact(t("Off-site backup"), backup!.text, !!backup!.problem)}
          {fact(t("Database snapshot"), status.last_backup_at ? new Date(status.last_backup_at * 1000).toLocaleString(locale()) : t("None yet. Written by scripts/backup.sh or the nightly backup."))}
        </>) : null}
      </ScrollView>
      <Portal>
        <Dialog visible={editing} onDismiss={close}>
          <Dialog.Title>{t("Default storage limit")}</Dialog.Title>
          <Dialog.Content>
            <Field label={t("Default limit in GB (0 = no limit)")} value={gb} onChangeText={setGb} keyboardType="decimal-pad" autoFocus />
            <Problem>{act.error}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={close} disabled={act.busy}>{t("Cancel")}</Button>
            <Button onPress={save} disabled={act.busy} icon={act.busy ? busyIcon : undefined}>{t("Save")}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const st = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingVertical: 16 },
  item: { minHeight: 56, paddingHorizontal: 8 },
  icon: { width: 40, alignItems: "center", justifyContent: "center", marginLeft: 8 },
});
