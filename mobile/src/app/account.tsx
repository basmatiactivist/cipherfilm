import { useEffect, useState } from "react";
import { AppState, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, Divider, List, Portal, ProgressBar, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { biometricPossible, disableBiometric, enableBiometric, forgetServer, lock, signOut, useSession } from "../session";
import { forgetLibrary } from "../libraryStore";
import { clearImages } from "../library";
import { Icon } from "../icons";
import { Problem, SwitchItem, useAppTheme } from "../ui";
import { setShake, useShake } from "../shake";
import { text } from "../tokens";

const gb = (n: number) => (n < 1e9 ? `${Math.max(n > 0 ? 0.1 : 0, n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(n < 1e10 ? 2 : 1)} GB`);

export default function Account() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const { me, server, biometric } = useSession();
  const [usage, setUsage] = useState<{ used_bytes: number; quota_bytes: number; unlimited: boolean }>();
  const [error, setError] = useState<string>();
  const [confirmOut, setConfirmOut] = useState(false);
  const [bioOk, setBioOk] = useState(() => biometricPossible());
  const shake = useShake();
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") setBioOk(biometricPossible()); }); // back from Android settings
    return () => sub.remove();
  }, []);
  useEffect(() => { api("GET", "/api/me/usage").then(setUsage, () => {}); }, []);

  const leave = async (how: "lock" | "out" | "server") => {
    clearImages();
    forgetLibrary();
    if (how === "lock") lock(true);
    else if (how === "out") await signOut();
    else { await signOut(); await forgetServer(); }
    router.replace("/");
  };
  const toggleBio = async () => {
    setError(undefined);
    try { biometric ? await disableBiometric() : await enableBiometric(); } catch (e) { setError((e as Error).message); }
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
        <List.Item title="Backup" description="Back up new photos and videos from this phone automatically"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="cloud" color={t.colors.primary} /></View>} onPress={() => router.push("/backup")} style={st.item} />
        <List.Item title="Search and people" description="Find photos by what's in them and who is in them, on this phone"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="search" color={t.colors.primary} /></View>} onPress={() => router.push("/search-settings")} style={st.item} />
        <List.Item title="Free up space" description="Remove photos from this phone that are already safe in Cipherfilm"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="phone" color={t.colors.primary} /></View>} onPress={() => router.push("/free-space")} style={st.item} />
        <SwitchItem title="Unlock with fingerprint or face"
          description={bioOk || biometric ? "Your key stays in this phone's secure hardware" : "Set up a fingerprint or face unlock in Android's settings first"}
          left={() => <View style={st.icon}><Icon name="fingerprint" color={bioOk || biometric ? t.colors.primary : t.colors.onSurfaceDisabled} /></View>}
          value={biometric} onValueChange={toggleBio} disabled={!bioOk && !biometric} />
        <SwitchItem title="Shake to lock and close"
          description="Two strong shakes lock your library and close Cipherfilm, in case someone grabs the phone"
          left={() => <View style={st.icon}><Icon name="phone" color={t.colors.primary} /></View>}
          value={shake} onValueChange={setShake} />
        <List.Item title="Lock now" description="Your key leaves memory; unlock to see your photos again"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="lock" color={t.colors.primary} /></View>} onPress={() => leave("lock")} style={st.item} />
        <List.Item title="Sign out" description="Ends the session and deletes what this phone keeps for your account"
          descriptionNumberOfLines={3} left={() => <View style={st.icon}><Icon name="logout" color={t.colors.primary} /></View>} onPress={() => setConfirmOut(true)} style={st.item} />
        <Divider />
        <Text variant="bodySmall" style={[st.block, { color: t.colors.onSurfaceVariant }]}>
          Photos are encrypted on this phone before upload. The server only ever stores ciphertext. Password changes, invites and your recovery key are in Cipherfilm in the browser.
        </Text>
      </ScrollView>
      <Portal>
        <Dialog visible={confirmOut} onDismiss={() => setConfirmOut(false)}>
          <Dialog.Title>Sign out of this phone?</Dialog.Title>
          <Dialog.Content><Text variant="bodyMedium">Your photos stay in Cipherfilm. This phone deletes its copies of your library, the backup and search settings, and its saved key; the automatic backup stops. You'll need your password to sign in again.</Text></Dialog.Content>
          {/* three actions don't fit side by side (least of all with large text): stacked, as Material does */}
          <Dialog.Actions style={st.stacked}>
            <Button onPress={() => { setConfirmOut(false); leave("out"); }}>Sign out</Button>
            <Button onPress={() => { setConfirmOut(false); leave("server"); }}>Sign out and change address</Button>
            <Button onPress={() => setConfirmOut(false)}>Cancel</Button>
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
