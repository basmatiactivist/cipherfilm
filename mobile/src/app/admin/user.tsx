// Administration › one person: their usage, and what an admin may change (the web's Admin › Users row). Nobody
// changes their own role, status or limit here (the server refuses it too); explicit search they may allow themselves.
// Deleting, disabling, a role change and turning off two-step sign-in ask first.
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Appbar, Button, Divider, List, Portal, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field, Problem, SwitchItem, useAppTheme, Dialog } from "../../ui";
import { Icon, type IconName } from "../../icons";
import { busyIcon } from "../../Loader";
import { useAction } from "../../useAction";
import { useSession } from "../../session";
import { explicitSearchOffered } from "../../store";
import { text } from "../../tokens";
import { t } from "../../i18n";
import {
  type AdminUser, badges, dateText, deleteUser, isAdmin, lastSeen, limitText, loadAccounts, noAccess, gbField, limitToSave, resetTwoStep,
  setAdmin, setEnabled, setExplicit, setLimit, usageLine,
} from "../../admin";

type Ask = "delete" | "disable" | "role" | "twostep" | "limit" | null;

export default function AdminUserPage() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useSession();
  const [u, setU] = useState<AdminUser | null>(null);
  const [gone, setGone] = useState(false);
  const [refused, setRefused] = useState(!isAdmin(me));
  const page = useAction();
  const load = () => page.run(async () => {
    try {
      const found = (await loadAccounts()).users.find((x) => x.id === id) ?? null;
      setU(found); setGone(!found);
    } catch (e) { if (noAccess(e)) { setRefused(true); return; } throw e; }
  });
  useEffect(() => { if (isAdmin(me)) load(); }, [id]);

  const [ask, setAsk] = useState<Ask>(null);
  const [gb, setGb] = useState("");
  const act = useAction();
  const close = () => { if (!act.busy) { setAsk(null); act.setError(undefined); } };
  const run = (f: () => Promise<unknown>, after?: () => void) => act.run(async () => { await f(); setAsk(null); if (after) after(); else await load(); });
  const self = u?.id === me?.user.id;
  const icon = (name: IconName, color = th.colors.primary) => () => <View style={st.icon}><Icon name={name} color={color} /></View>;

  const confirm: Record<Exclude<Ask, null | "limit">, { title: string; body: string; ok: string; go: () => void }> | null = u ? {
    delete: { title: t("Delete {email}?", { email: u.email }), body: t("Their account and everything they stored are deleted from the server right away. Nobody can bring them back. Their devices are signed out."), ok: t("Delete"), go: () => run(() => deleteUser(u.id), () => router.back()) },
    disable: { title: t("Disable {email}?", { email: u.email }), body: t("They are signed out on every device and can't sign in until you enable the account again. Their photos stay."), ok: t("Disable"), go: () => run(() => setEnabled(u.id, false)) },
    role: u.role === "admin"
      ? { title: t("Make {email} a regular user?", { email: u.email }), body: t("They can no longer manage people, invites or the server. They get the default storage limit."), ok: t("Make regular user"), go: () => run(() => setAdmin(u.id, false)) }
      : { title: t("Make {email} an administrator?", { email: u.email }), body: t("They can invite and delete people, change limits and see the server's state, but not anyone's photos. Administrators have no storage limit."), ok: t("Make admin"), go: () => run(() => setAdmin(u.id, true)) },
    twostep: { title: t("Turn off two-step sign-in for {email}?", { email: u.email }), body: t("Their password alone signs in until they turn it on again. Do this only when you're sure it's them asking. Their devices tell them."), ok: t("Turn off"), go: () => run(() => resetTwoStep(u.id)) },
  } : null;
  const c = ask && ask !== "limit" && confirm ? confirm[ask] : null;

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={u?.email ?? t("Person")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }}>
        <View style={st.block}>
          {refused ? <Text variant="bodyMedium">{t("Only administrators of this server can see this.")}</Text> : null}
          {gone ? <Text variant="bodyMedium">{t("This account no longer exists.")}</Text> : null}
          <Problem>{page.error}</Problem>
          {u ? (<>
            <Text variant="titleMedium">{u.email}</Text>
            <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant, marginTop: 4 }}>
              {[badges(u, explicitSearchOffered()).join(", "), lastSeen(u.last_login_at), t("joined {date}", { date: dateText(u.created_at) })].join(" · ")}
            </Text>
            <Text variant="bodyMedium" style={{ marginTop: 8 }}>{usageLine(u)}</Text>
          </>) : null}
        </View>
        {u && !refused ? (<>
          <Divider />
          {self ? <Text variant="bodySmall" style={[st.block, { color: th.colors.onSurfaceVariant }]}>{t("This is you. Your own role, status and limit can only be changed by another administrator.")}</Text> : null}
          {!self ? <List.Item title={t("Storage limit")} description={limitText(u.quota_bytes)} left={icon("cloud")}
            onPress={() => { setGb(gbField(u.quota_bytes)); setAsk("limit"); }} style={st.item} /> : null}
          {/* off for everyone by default; the person still turns it on in their app. Never offered by the Play build. */}
          {explicitSearchOffered() ? <SwitchItem title={t("Allow explicit search")} description={t("Lets them turn off the filter that leaves explicit photos out of search. Off for everyone by default.")}
            left={icon("search")} value={u.nsfw} disabled={act.busy} onValueChange={(v) => run(() => setExplicit(u.id, v))} style={st.item} /> : null}
          {!self && u.two_factor ? <List.Item title={t("Turn off two-step sign-in")} description={t("For someone who lost their authenticator and recovery codes")}
            descriptionNumberOfLines={3} left={icon("key")} onPress={() => setAsk("twostep")} style={st.item} /> : null}
          {!self ? <List.Item title={u.role === "admin" ? t("Make regular user") : t("Make admin")} description={u.role === "admin" ? t("Currently an administrator") : t("Currently a regular user")}
            left={icon("shield")} onPress={() => setAsk("role")} style={st.item} /> : null}
          {!self ? (u.status === "active"
            ? <List.Item title={t("Disable")} description={t("Signs them out everywhere; their photos stay")} descriptionNumberOfLines={3} left={icon("slash")} onPress={() => setAsk("disable")} style={st.item} />
            : <List.Item title={t("Enable")} description={t("They can sign in again")} left={icon("check")} onPress={() => run(() => setEnabled(u.id, true))} style={st.item} />) : null}
          {!self ? <List.Item title={t("Delete account")} titleStyle={{ color: th.colors.error }} description={t("Deletes their account and everything they stored")}
            descriptionNumberOfLines={3} left={icon("trash", th.colors.error)} onPress={() => setAsk("delete")} style={st.item} /> : null}
          <View style={{ paddingHorizontal: 16 }}><Problem>{ask === null ? act.error : undefined}</Problem></View>
        </>) : null}
      </ScrollView>
      <Portal>
        <Dialog visible={!!c} onDismiss={close}>
          <Dialog.Title>{c?.title}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{c?.body}</Text>
            <Problem>{act.error}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={close} disabled={act.busy}>{t("Cancel")}</Button>
            <Button textColor={ask === "role" ? th.colors.primary : th.colors.error} onPress={() => c?.go()} disabled={act.busy} icon={act.busy ? busyIcon : undefined}>{c?.ok}</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={ask === "limit"} onDismiss={close}>
          <Dialog.Title>{t("Storage limit")}</Dialog.Title>
          <Dialog.Content>
            <Field label={t("Limit in GB (0 = no limit)")} value={gb} onChangeText={setGb} keyboardType="decimal-pad" autoFocus />
            <Problem>{act.error}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={close} disabled={act.busy}>{t("Cancel")}</Button>
            <Button onPress={() => u && run(() => setLimit(u.id, limitToSave(gb, gbField(u.quota_bytes), u.quota_bytes)))} disabled={act.busy} icon={act.busy ? busyIcon : undefined}>{t("Save")}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const st = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingVertical: 16 },
  item: { minHeight: 64, paddingHorizontal: 8 },
  icon: { width: 40, alignItems: "center", justifyContent: "center", marginLeft: 8 },
});
