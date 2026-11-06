import { useEffect, useState } from "react";
import { AppState, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, Divider, List, Portal, ProgressBar, RadioButton, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N from "../../modules/cf-native/src/CfNativeModule";
import { api } from "../api";
import { biometricPossible, deleteAccount, disableBiometric, enableBiometric, forgetServer, lock, signOut, useSession } from "../session";
import { forgetLibrary } from "../libraryStore";
import { clearImages } from "../library";
import { Icon } from "../icons";
import { Field, Problem, SwitchItem, useAppTheme } from "../ui";
import { setShake, useShake } from "../shake";
import { CHOICES, away, setAutoLock, useAutoLock } from "../autolock";
import { text } from "../tokens";

const gb = (n: number) => (n < 1e9 ? `${Math.max(n > 0 ? 0.1 : 0, n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(n < 1e10 ? 2 : 1)} GB`);

export default function Account() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const { me, server, biometric } = useSession();
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
      setDelError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setDelBusy(false);
    }
  };
  const toggleBio = async () => {
    setError(undefined);
    try { biometric ? await disableBiometric() : await away(enableBiometric); } catch (e) { setError((e as Error).message); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <Appbar.Header style={{ backgroundColor: t.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
        <Appbar.Content title="Account" titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }}>
        <View style={st.block}>
          <Text variant="titleMedium" numberOfLines={1}>{me?.user.email}</Text>
          <Text variant="bodySmall" style={{ color: t.colors.onSurfaceVariant }} numberOfLines={1}>{server.replace(/^https:\/\//, "")}</Text>
        </View>
        {usage ? (
          <View style={st.block}>
            <Text variant="bodyMedium" style={{ marginBottom: 8 }}>
              {usage.unlimited ? `${gb(usage.used_bytes)} used` : `${gb(usage.used_bytes)} of ${gb(usage.quota_bytes)} used`}
            </Text>
            {!usage.unlimited ? <ProgressBar progress={Math.min(1, usage.used_bytes / Math.max(1, usage.quota_bytes))} color={t.colors.primary} style={{ height: 5, borderRadius: 3, backgroundColor: t.colors.outlineVariant }} /> : null}
          </View>
        ) : null}
        <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>
        <Divider />
        <List.Item title="Backup" description="Back up new photos and videos automatically"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="cloud" color={t.colors.primary} /></View>} onPress={() => router.push("/backup")} style={st.item} />
        <List.Item title="Search and people" description="Find photos by what and who is in them"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="search" color={t.colors.primary} /></View>} onPress={() => router.push("/search-settings")} style={st.item} />
        <List.Item title="Free up space" description="Remove photos from this phone that are already in Cipherfilm"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="phone" color={t.colors.primary} /></View>} onPress={() => router.push("/free-space")} style={st.item} />
        <SwitchItem title="Unlock with fingerprint or face"
          description={bioOk || biometric ? "Your key stays in this phone's secure hardware" : "Set up fingerprint or face unlock in Android settings first"}
          left={() => <View style={st.icon}><Icon name="fingerprint" color={bioOk || biometric ? t.colors.primary : t.colors.onSurfaceDisabled} /></View>}
          value={biometric} onValueChange={toggleBio} disabled={!bioOk && !biometric} style={st.item} />
        <List.Item title="Lock when you leave the app" description={CHOICES.find((c) => c.after === auto.after)?.label}
          left={() => <View style={st.icon}><Icon name="lock" color={t.colors.primary} /></View>} onPress={() => setPickLock(true)} style={st.item} />
        <SwitchItem title="Lock when the screen turns off"
          left={() => <View style={st.icon}><Icon name="phone" color={t.colors.primary} /></View>}
          value={auto.screenOff} onValueChange={(v) => setAutoLock({ screenOff: v })} style={st.item} />
        <SwitchItem title="Shake to lock and close"
          description="Two strong shakes lock and close Cipherfilm"
          left={() => <View style={st.icon}><Icon name="phone" color={t.colors.primary} /></View>}
          value={shake} onValueChange={setShake} style={st.item} />
        <List.Item title="Lock now" description="Unlock again to see your photos"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="lock" color={t.colors.primary} /></View>} onPress={() => leave("lock")} style={st.item} />
        <List.Item title="Sign out" description="Removes your account from this phone"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="logout" color={t.colors.primary} /></View>} onPress={() => setConfirmOut(true)} style={st.item} />
        <List.Item title="Delete account" titleStyle={{ color: t.colors.error }} description="Deletes your account and all your photos"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="trash" color={t.colors.error} /></View>} onPress={() => setDel("warn")} style={st.item} />
        <Divider />
        <Text variant="bodySmall" style={[st.block, { color: t.colors.onSurfaceVariant }]}>
          Photos are encrypted on this phone before upload. The server only stores encrypted data. Change your password, invite people and make a new recovery key in Cipherfilm in the browser.
        </Text>
        <Divider />
        <List.Subheader>About</List.Subheader>
        <List.Item title="App version" description={app ?? "Unknown"} style={st.item} />
        <List.Item title="Server version" description={serverVersion ?? "Unknown"} style={st.item} />
      </ScrollView>
      <Portal>
        <Dialog visible={pickLock} onDismiss={() => setPickLock(false)}>
          <Dialog.Title>Lock when you leave the app</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ marginBottom: 8 }}>Backup keeps running while locked.</Text>
            <RadioButton.Group value={String(auto.after)} onValueChange={(v) => { setAutoLock({ after: Number(v) }); setPickLock(false); }}>
              {CHOICES.map((c) => <RadioButton.Item key={c.after} label={c.label} value={String(c.after)} />)}
            </RadioButton.Group>
          </Dialog.Content>
        </Dialog>
        <Dialog visible={confirmOut} onDismiss={() => setConfirmOut(false)}>
          <Dialog.Title>Sign out of this phone?</Dialog.Title>
          <Dialog.Content><Text variant="bodyMedium">Your photos stay in Cipherfilm. This phone deletes its copy of your library, its settings and its saved key, and backup stops. You need your password to sign in again.</Text></Dialog.Content>
          {/* three actions don't fit side by side (least of all with large text): stacked, as Material does */}
          <Dialog.Actions style={st.stacked}>
            <Button onPress={() => { setConfirmOut(false); leave("out"); }}>Sign out</Button>
            <Button onPress={() => { setConfirmOut(false); leave("server"); }}>Sign out and change address</Button>
            <Button onPress={() => setConfirmOut(false)}>Cancel</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={del === "warn"} onDismiss={closeDel}>
          <Dialog.Title>Delete your account?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">All your photos, videos, albums, people and search data are deleted from {server.replace(/^https:\/\//, "")} right away. Nobody can bring them back, not even an admin. All your devices are signed out.</Text>
            <Text variant="bodyMedium" style={{ marginTop: 12 }}>Photos on this phone stay on it. Save anything else you want to keep first.</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeDel}>Cancel</Button>
            <Button textColor={t.colors.error} onPress={() => setDel("password")}>Continue</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={del === "password"} onDismiss={closeDel}>
          <Dialog.Title>Enter your password</Dialog.Title>
          <Dialog.Content>
            <Field label="Password" value={delPw} onChangeText={setDelPw} secureTextEntry textContentType="password" autoComplete="current-password" autoFocus
              hint={delBusy ? "Checking your password…" : undefined} />
            <Problem>{delError}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeDel} disabled={delBusy}>Cancel</Button>
            <Button textColor={t.colors.error} onPress={doDelete} loading={delBusy} disabled={delBusy || !delPw}>Delete account</Button>
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
