import { useEffect, useState } from "react";
import { AppState, Linking, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, Divider, List, Portal, ProgressBar, RadioButton, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N from "../../modules/cf-native/src/CfNativeModule";
import { api } from "../api";
import { demoNote, biometricPossible, deleteAccount, disableBiometric, enableBiometric, forgetServer, lock, signOut, useSession } from "../session";
import { forgetLibrary } from "../libraryStore";
import { clearImages } from "../library";
import { Icon } from "../icons";
import { Field, Problem, SwitchItem, useAppTheme } from "../ui";
import { setShake, useShake } from "../shake";
import { CHOICES, away, expectAway, setAutoLock, useAutoLock } from "../autolock";
import { privacyUrl } from "../store";
import { mapPrivacyUrl, mapProvider, setMapOn, useMapOn } from "../mapConsent";
import { reportUrl, summary, thisPhone } from "../report";
import { text } from "../tokens";
import { busyIcon } from "../Loader";
import { locale, t } from "../i18n";

/** GitHub's issue form in the browser: the GitHub app would open its start page and drop the prefilled details. */
const inBrowser = (url: string) => { let ok = false; try { ok = N.openInBrowser(url); } catch { /* older native build */ } if (!ok) Linking.openURL(url); };

const fixed = (n: number, d: number) => n.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });
const gb = (n: number) => (n < 1e9 ? `${fixed(Math.max(n > 0 ? 0.1 : 0, n / 1e6), 1)} MB` : `${fixed(n / 1e9, n < 1e10 ? 2 : 1)} GB`);

export default function Account() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { me, server, biometric } = useSession();
  const mapOn = useMapOn();
  const [usage, setUsage] = useState<{ used_bytes: number; quota_bytes: number; unlimited: boolean }>();
  const [error, setError] = useState<string>();
  const [confirmOut, setConfirmOut] = useState(false);
  // Delete account: a warning, then the password (checked here first, then sent as the sign-in proof)
  const [del, setDel] = useState<"" | "warn" | "password">("");
  const [delPw, setDelPw] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string>();
  const [bioOk, setBioOk] = useState(() => biometricPossible());
  const shake = useShake();
  const auto = useAutoLock();
  const [pickLock, setPickLock] = useState(false);
  const [report, setReport] = useState(false);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") setBioOk(biometricPossible()); }); // back from Android settings
    return () => sub.remove();
  }, []);
  useEffect(() => { api("GET", "/api/me/usage").then(setUsage, () => {}); }, []);
  const [app] = useState(() => { try { const v = N.appVersion(); return v.name ? `${v.name} (${v.code})` : undefined; } catch { return undefined; } });
  const [serverVersion, setServerVersion] = useState(me?.server_version);
  useEffect(() => {
    if (me?.server_version) { setServerVersion(me.server_version); return; }
    // older sign-ins (or older servers) have it only here, if at all
    api<{ server_version?: string }>("GET", "/api/setup/status").then((r) => setServerVersion(typeof r.server_version === "string" ? r.server_version : undefined), () => {});
  }, [me?.server_version]);
  // read once per dialog, so the link carries exactly the line the dialog shows
  const phone = report ? thisPhone(serverVersion) : undefined;

  const leave = async (how: "lock" | "out" | "server") => {
    clearImages();
    forgetLibrary();
    if (how === "lock") lock(true);
    else if (how === "out") await signOut();
    else { await signOut(); await forgetServer(); }
    router.replace("/");
  };
  const closeDel = () => { if (!delBusy) { setDel(""); setDelPw(""); setDelError(undefined); } };
  const doDelete = async () => {
    setDelError(undefined); setDelBusy(true);
    try {
      await deleteAccount(delPw);
      setDel(""); setDelPw("");
      clearImages();
      forgetLibrary();
      router.replace("/");
    } catch (e) {
      setDelError(e instanceof Error ? e.message : t("That didn't work."));
    } finally {
      setDelBusy(false);
    }
  };
  const toggleBio = async () => {
    setError(undefined);
    try { biometric ? await disableBiometric() : await away(enableBiometric); } catch (e) { setError((e as Error).message); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Account")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }}>
        <View style={st.block}>
          <Text variant="titleMedium" numberOfLines={1}>{me?.user.email}</Text>
          <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant }} numberOfLines={1}>{server.replace(/^https:\/\//, "")}</Text>
          {me?.demo ? <Text variant="labelLarge" style={{ color: th.colors.primary, marginTop: 4 }}>{demoNote()}</Text> : null}
        </View>
        {usage ? (
          <View style={st.block}>
            <Text variant="bodyMedium" style={{ marginBottom: 8 }}>
              {usage.unlimited ? t("{used} used", { used: gb(usage.used_bytes) }) : t("{used} of {quota} used", { used: gb(usage.used_bytes), quota: gb(usage.quota_bytes) })}
            </Text>
            {!usage.unlimited ? <ProgressBar progress={Math.min(1, usage.used_bytes / Math.max(1, usage.quota_bytes))} color={th.colors.primary} style={{ height: 5, borderRadius: 3, backgroundColor: th.colors.outlineVariant }} /> : null}
          </View>
        ) : null}
        <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>
        <Divider />
        <List.Item title={t("Backup")} description={t("Back up new photos and videos automatically")}
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="cloud" color={th.colors.primary} /></View>} onPress={() => router.push("/backup")} style={st.item} />
        <List.Item title={t("Search and people")} description={t("Find photos by what and who is in them")}
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="search" color={th.colors.primary} /></View>} onPress={() => router.push("/search-settings")} style={st.item} />
        <List.Item title={t("Free up space")} description={t("Remove photos from this phone that are already in Cipherfilm")}
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="phone" color={th.colors.primary} /></View>} onPress={() => router.push("/free-space")} style={st.item} />
        {me?.map ? <SwitchItem title={t("Map")} description={t("Loads map images from {who}. Photo locations stay on this phone.", { who: mapProvider() || t("the map server") })}
          value={mapOn} onValueChange={(v) => setMapOn(v)} /> : null}
        {me?.map ? <List.Item title={t("About the map and privacy")} description={mapPrivacyUrl().replace("https://", "")}
          onPress={() => { expectAway(); Linking.openURL(mapPrivacyUrl()); }} style={st.item} /> : null}
        <SwitchItem title={t("Unlock with fingerprint or face")}
          description={bioOk || biometric ? t("Your key stays in this phone's secure hardware") : t("Set up fingerprint or face unlock in Android settings first")}
          left={() => <View style={st.icon}><Icon name="fingerprint" color={bioOk || biometric ? th.colors.primary : th.colors.onSurfaceDisabled} /></View>}
          value={biometric} onValueChange={toggleBio} disabled={!bioOk && !biometric} style={st.item} />
        <List.Item title={t("Lock when you leave the app")} description={CHOICES.find((c) => c.after === auto.after)?.label}
          left={() => <View style={st.icon}><Icon name="lock" color={th.colors.primary} /></View>} onPress={() => setPickLock(true)} style={st.item} />
        <SwitchItem title={t("Lock when the screen turns off")}
          left={() => <View style={st.icon}><Icon name="phone" color={th.colors.primary} /></View>}
          value={auto.screenOff} onValueChange={(v) => setAutoLock({ screenOff: v })} style={st.item} />
        <SwitchItem title={t("Shake to lock and close")}
          description={t("Two strong shakes lock and close Cipherfilm")}
          left={() => <View style={st.icon}><Icon name="phone" color={th.colors.primary} /></View>}
          value={shake} onValueChange={setShake} style={st.item} />
        <List.Item title={t("Lock now")} description={t("Unlock again to see your photos")}
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="lock" color={th.colors.primary} /></View>} onPress={() => leave("lock")} style={st.item} />
        <List.Item title={t("Sign out")} description={t("Removes your account from this phone")}
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="logout" color={th.colors.primary} /></View>} onPress={() => setConfirmOut(true)} style={st.item} />
        {me?.demo ? null : <List.Item title={t("Delete account")} titleStyle={{ color: th.colors.error }} description={t("Deletes your account and all your photos")}
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="trash" color={th.colors.error} /></View>} onPress={() => setDel("warn")} style={st.item} />}
        <Divider />
        <Text variant="bodySmall" style={[st.block, { color: th.colors.onSurfaceVariant }]}>
          {t("Photos are encrypted on this phone before upload. The server only stores encrypted data. Change your password, invite people and make a new recovery key in Cipherfilm in the browser.")}
        </Text>
        <Divider />
        <List.Subheader>{t("About")}</List.Subheader>
        <List.Item title={t("App version")} description={app ?? t("Unknown")} style={st.item} />
        <List.Item title={t("Server version")} description={serverVersion ?? t("Unknown")} style={st.item} />
        <List.Item title={t("Privacy policy")} description={privacyUrl().replace("https://", "")}
          onPress={() => { expectAway(); Linking.openURL(privacyUrl()); }} style={st.item} />
        <List.Item title={t("Report a problem")} description={t("Opens a form on GitHub")}
          onPress={() => setReport(true)} style={st.item} />
      </ScrollView>
      <Portal>
        <Dialog visible={pickLock} onDismiss={() => setPickLock(false)}>
          <Dialog.Title>{t("Lock when you leave the app")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ marginBottom: 8 }}>{t("Backup keeps running while locked.")}</Text>
            <RadioButton.Group value={String(auto.after)} onValueChange={(v) => { setAutoLock({ after: Number(v) }); setPickLock(false); }}>
              {CHOICES.map((c) => <RadioButton.Item key={c.after} label={c.label} value={String(c.after)} />)}
            </RadioButton.Group>
          </Dialog.Content>
        </Dialog>
        {/* asks first and shows exactly what the link fills in; the browser opens it, the app sends nothing */}
        <Dialog visible={report} onDismiss={() => setReport(false)}>
          <Dialog.Title>{t("Report a problem on GitHub")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("You'll continue on github.com (a free GitHub account is needed to post). We'll fill in this phone's details:")}</Text>
            <Text variant="bodyMedium" style={{ marginVertical: 12, fontWeight: "600" }}>{phone ? summary(phone) : ""}</Text>
            <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant }}>{t("Nothing else is sent: no server address, e-mail, photos or names.")}</Text>
          </Dialog.Content>
          <Dialog.Actions style={st.stacked}>
            <Button mode="contained" onPress={() => { setReport(false); expectAway(); inBrowser(reportUrl(phone)); }}>{t("Include details")}</Button>
            <Button onPress={() => { setReport(false); expectAway(); inBrowser(reportUrl()); }}>{t("Without details")}</Button>
            <Button onPress={() => setReport(false)}>{t("Cancel")}</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={confirmOut} onDismiss={() => setConfirmOut(false)}>
          <Dialog.Title>{t("Sign out of this phone?")}</Dialog.Title>
          <Dialog.Content><Text variant="bodyMedium">{t("Your photos stay in Cipherfilm. This phone deletes its copy of your library, its settings and its saved key, and backup stops. You need your password to sign in again.")}</Text></Dialog.Content>
          {/* three actions don't fit side by side (least of all with large text): stacked, as Material does */}
          <Dialog.Actions style={st.stacked}>
            <Button onPress={() => { setConfirmOut(false); leave("out"); }}>{t("Sign out")}</Button>
            <Button onPress={() => { setConfirmOut(false); leave("server"); }}>{t("Sign out and change address")}</Button>
            <Button onPress={() => setConfirmOut(false)}>{t("Cancel")}</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={del === "warn"} onDismiss={closeDel}>
          <Dialog.Title>{t("Delete your account?")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("All your photos, videos, albums, people and search data are deleted from {server} right away. Nobody can bring them back, not even an admin. All your devices are signed out.", { server: server.replace(/^https:\/\//, "") })}</Text>
            <Text variant="bodyMedium" style={{ marginTop: 12 }}>{t("Photos on this phone stay on it. Save anything else you want to keep first.")}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeDel}>{t("Cancel")}</Button>
            <Button textColor={th.colors.error} onPress={() => setDel("password")}>{t("Continue")}</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={del === "password"} onDismiss={closeDel}>
          <Dialog.Title>{t("Enter your password")}</Dialog.Title>
          <Dialog.Content>
            <Field label={t("Password")} value={delPw} onChangeText={setDelPw} secureTextEntry textContentType="password" autoComplete="current-password" autoFocus
              hint={delBusy ? t("Checking your password…") : undefined} />
            <Problem>{delError}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeDel} disabled={delBusy}>{t("Cancel")}</Button>
            <Button textColor={th.colors.error} onPress={doDelete} icon={delBusy ? busyIcon : undefined} disabled={delBusy || !delPw}>{t("Delete account")}</Button>
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
  stacked: { flexDirection: "column", alignItems: "flex-end", gap: 4 },
});
