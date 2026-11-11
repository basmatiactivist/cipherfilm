// Account › Administration (admins only): the people on this server, open invites and a new one, and the way to the
// server's state and the activity log. The same capabilities as the web's Admin area; the server checks every request
// (a non-admin gets "not found"), this screen only says so. Admins see sizes and counts, never anyone's photos or names.
import { useCallback, useState } from "react";
import { ScrollView, Share, StyleSheet, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Appbar, Button, Dialog, Divider, List, Portal, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field, Problem, useAppTheme } from "../../ui";
import { Icon } from "../../icons";
import { busyIcon } from "../../Loader";
import { useAction } from "../../useAction";
import { useSession } from "../../session";
import { away } from "../../autolock";
import { explicitSearchOffered } from "../../store";
import { text } from "../../tokens";
import { t } from "../../i18n";
import {
  type Accounts, type AdminInvite, backupState, badges, createInvite, dateText, isAdmin, lastSeen, limitText, loadAccounts,
  loadStatus, noAccess, revokeInvite, summaryLine, usageLine,
} from "../../admin";

export default function Admin() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { me } = useSession();
  const [data, setData] = useState<Accounts | null>(null);
  const [refused, setRefused] = useState(!isAdmin(me));
  const [backupProblem, setBackupProblem] = useState<string>();
  const page = useAction();
  const load = () => page.run(async () => {
    try { setData(await loadAccounts()); } catch (e) { if (noAccess(e)) { setRefused(true); return; } throw e; }
    loadStatus().then((s) => setBackupProblem(backupState(s).problem), () => {});
  });
  // again whenever it shows: a person's page may have changed or deleted them
  useFocusEffect(useCallback(() => { if (isAdmin(me)) load(); }, [me]));

  // a new invite: e-mail and an optional limit, then the link, shown once
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [gb, setGb] = useState("");
  const [link, setLink] = useState<{ link: string; email: string; expires_at: number } | null>(null);
  const inv = useAction();
  const closeInvite = () => { if (!inv.busy) { setInviting(false); setEmail(""); setGb(""); setLink(null); inv.setError(undefined); } };
  const create = () => inv.run(async () => { setLink(await createInvite(email, gb)); load(); });
  const share = (l: string) => away(() => Share.share({ message: l })).catch(() => {});

  const [revoke, setRevoke] = useState<AdminInvite | null>(null);
  const act = useAction();
  const closeRevoke = () => { if (!act.busy) { setRevoke(null); act.setError(undefined); } };
  const doRevoke = () => act.run(async () => { if (revoke) await revokeInvite(revoke.id); setRevoke(null); load(); });

  const icon = (name: Parameters<typeof Icon>[0]["name"], color = th.colors.primary) => () => <View style={st.icon}><Icon name={name} color={color} /></View>;
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Administration")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }}>
        {refused ? (
          <View style={st.block}><Text variant="bodyMedium">{t("Only administrators of this server can see this.")}</Text></View>
        ) : (<>
          <View style={st.block}>
            <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant }}>
              {(data ? summaryLine(data.users) + ". " : "") + t("Administrators can't see anyone's photos, album names or file names.")}
            </Text>
            <Problem>{page.error}</Problem>
            <Problem>{backupProblem ? backupProblem + " " + t("Details under Server.") : undefined}</Problem>
            <Button mode="contained" icon={() => <Icon name="plus" color={th.colors.onPrimary} size={20} />} onPress={() => setInviting(true)} style={{ marginTop: 8, alignSelf: "flex-start" }}>{t("Invite someone")}</Button>
          </View>
          {data && data.invites.length > 0 ? (<>
            <Divider />
            <List.Subheader>{t("Open invites")}</List.Subheader>
            {data.invites.map((i) => (
              <List.Item key={i.id} title={i.email} titleNumberOfLines={2} descriptionNumberOfLines={3}
                description={t("Waiting, link valid until {date}. Limit: {limit}.", { date: dateText(i.expires_at), limit: limitText(i.quota_bytes) })}
                left={icon("key")} right={() => <Button compact onPress={() => setRevoke(i)} accessibilityLabel={t("Revoke the invite for {email}", { email: i.email })}>{t("Revoke")}</Button>}
                style={st.item} />
            ))}
          </>) : null}
          <Divider />
          <List.Subheader>{t("People")}</List.Subheader>
          {(data?.users ?? []).map((u) => (
            <List.Item key={u.id} title={u.email + (u.id === me?.user.id ? " " + t("(you)") : "")} titleNumberOfLines={2} descriptionNumberOfLines={4}
              description={[badges(u, explicitSearchOffered()).join(", "), lastSeen(u.last_login_at), usageLine(u)].join(" · ")}
              left={icon(u.role === "admin" ? "shield" : u.status === "active" ? "user" : "slash", u.status === "active" ? th.colors.primary : th.colors.onSurfaceVariant)}
              onPress={() => router.push({ pathname: "/admin/user", params: { id: u.id } })} style={st.item} />
          ))}
          <Divider />
          <List.Item title={t("Server")} description={t("Disk, backup, version, and the default storage limit ({limit})", { limit: data ? limitText(data.default_quota_bytes) : "…" })}
            descriptionNumberOfLines={3} left={icon("cloud")} onPress={() => router.push("/admin/server")} style={st.item} />
          <List.Item title={t("Activity")} description={t("Invites, role and limit changes, and removals")}
            descriptionNumberOfLines={3} left={icon("restore")} onPress={() => router.push("/admin/activity")} style={st.item} />
        </>)}
      </ScrollView>
      <Portal>
        <Dialog visible={inviting} onDismiss={closeInvite}>
          <Dialog.Title>{link ? t("Invite link") : t("Invite someone")}</Dialog.Title>
          {link ? (<>
            <Dialog.Content>
              <Text variant="bodyMedium">{t("Invite link for {email}, valid until {date}. It's shown only once: share it now.", { email: link.email, date: dateText(link.expires_at) })}</Text>
              <Text variant="bodySmall" selectable style={[st.link, { backgroundColor: th.colors.surfaceVariant }]}>{link.link}</Text>
            </Dialog.Content>
            <Dialog.Actions>
              <Button onPress={closeInvite}>{t("Done")}</Button>
              <Button mode="contained" icon={() => <Icon name="share" color={th.colors.onPrimary} size={18} />} onPress={() => share(link.link)}>{t("Share link")}</Button>
            </Dialog.Actions>
          </>) : (<>
            <Dialog.Content>
              <Text variant="bodyMedium" style={{ marginBottom: 12 }}>{t("Cipherfilm doesn't send e-mail. Send the link yourself. It works once and expires after 7 days.")}</Text>
              <Field label={t("Their e-mail")} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="off" autoFocus />
              <Field label={t("Storage limit in GB (optional)")} value={gb} onChangeText={setGb} keyboardType="decimal-pad"
                hint={t("Leave empty for the default ({limit}). 0 means no limit.", { limit: data ? limitText(data.default_quota_bytes) : "…" })} />
              <Problem>{inv.error}</Problem>
            </Dialog.Content>
            <Dialog.Actions>
              <Button onPress={closeInvite} disabled={inv.busy}>{t("Cancel")}</Button>
              <Button onPress={create} disabled={inv.busy || !email.trim()} icon={inv.busy ? busyIcon : undefined}>{t("Create invite link")}</Button>
            </Dialog.Actions>
          </>)}
        </Dialog>
        <Dialog visible={revoke !== null} onDismiss={closeRevoke}>
          <Dialog.Title>{t("Revoke the invite?")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("The link for {email} stops working. You can invite them again later.", { email: revoke?.email ?? "" })}</Text>
            <Problem>{act.error}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeRevoke} disabled={act.busy}>{t("Cancel")}</Button>
            <Button textColor={th.colors.error} onPress={doRevoke} disabled={act.busy} icon={act.busy ? busyIcon : undefined}>{t("Revoke")}</Button>
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
  link: { marginTop: 12, padding: 10, borderRadius: 8, fontFamily: "monospace" },
});
