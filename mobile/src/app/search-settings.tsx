import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { ActivityIndicator, Appbar, Button, Dialog, Divider, List, Portal, ProgressBar, Switch, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N from "../../modules/cf-native/src/CfNativeModule";
import { api, server } from "../api";
import { refreshMe, session, useSession } from "../session";
import { libraryItems } from "../libraryStore";
import { scheduleBackground } from "../backup";
import { forgetSearch, indexesHere, indexHere, startSearch, stopSearch, useSearchProgress } from "../search/engine";
import { loadPeople, setExplicit } from "../search/people";
import { explicitSearchOffered } from "../store";
import { expectAway } from "../autolock";
import { ownBatteryRules, useOnReturn } from "../deviceState";
import { deleteModels, downloadSize } from "../search/models";
import { loadSettings, onSettingsChange, pinAccount, saveSettings, type SearchSettings } from "../search/settings";
import { Problem, SwitchItem, useAppTheme } from "../ui";
import { radius, text } from "../tokens";

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** Search and people: on or off, faces or not, when the phone works on it, and what it keeps. */
export default function SearchSettingsScreen() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const [s, setS] = useState<SearchSettings | null>(null);
  // explicit search: offered only where an admin allowed it; the choice is the account's (docs/SEARCH.md). The
  // account is fetched again here, so a permission the admin gave since sign-in shows at once.
  const me = useSession().me;
  const allowed = !!me?.user.nsfw && explicitSearchOffered(); // never in the Play build (src/store.ts)
  const [fresh, setFresh] = useState(false);
  const [explicit, setExplicitState] = useState<boolean | null>(null);
  // the device that computes the index, when it isn't this phone (docs/SEARCH.md "One device indexes")
  const [indexer, setIndexer] = useState<{ device: string; last_seen: number } | null>(null);
  const here = indexesHere(me);
  useEffect(() => { refreshMe().catch(() => null).finally(() => setFresh(true)); }, []);
  useEffect(() => { if (allowed) loadPeople().then((d) => setExplicitState(!!d.explicit), () => setExplicitState(false)); }, [allowed]);
  useEffect(() => {
    if (here) { setIndexer(null); return; }
    api<{ sessions: { device: string; last_seen: number; indexer: boolean }[] }>("GET", "/api/me/sessions")
      .then((r) => setIndexer(r.sessions.find((x) => x.indexer) ?? { device: "another device", last_seen: 0 }), () => setIndexer({ device: "another device", last_seen: 0 }));
  }, [here, me?.indexer]);
  const [error, setError] = useState<string>();
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState(() => N.backupState());
  const p = useSearchProgress();
  useOnReturn(() => setDevice(N.backupState())); // back from Android's settings
  useEffect(() => {
    loadSettings().then(setS);
    const a = onSettingsChange(() => loadSettings().then(setS));
    return () => { a(); };
  }, []);

  const restart = () => { startSearch(libraryItems()).catch(() => {}); };
  const change = async (patch: Partial<SearchSettings>, again = true) => {
    setError(undefined);
    try {
      await saveSettings(patch);
      await scheduleBackground();
      if (again) restart();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
  };

  // where explicit search is allowed, the model is chosen before anything downloads (it can be changed later)
  const [choose, setChoose] = useState(false);
  const turnOn = async (model?: "standard" | "explicit") => {
    if (!model) {
      setBusy(true);
      // the permission as it is now, then always the question where it is allowed
      const now = await refreshMe().catch(() => session().me);
      setBusy(false);
      if (now?.user.nsfw && explicitSearchOffered()) { loadPeople().then((d) => setExplicitState(!!d.explicit), () => {}); setChoose(true); return; }
    }
    setChoose(false);
    setBusy(true); setError(undefined);
    try {
      const { me, masterKey } = session();
      if (!me || !masterKey) throw new Error("Unlock your library first.");
      if (model) { const on = model === "explicit"; await setExplicit(on); setExplicitState(on); }
      await saveSettings({ enabled: true, asked: true, ...(await pinAccount(me, server(), masterKey)) });
      await scheduleBackground();
      restart();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } finally { setBusy(false); }
  };
  const turnOff = async (clear: boolean) => {
    setOff(false); setBusy(true);
    try {
      stopSearch();
      await saveSettings({ enabled: false, asked: true });
      await scheduleBackground();
      await forgetSearch(clear);
      deleteModels();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } finally { setBusy(false); }
  };

  if (!s || !fresh) return <View style={{ flex: 1, backgroundColor: t.colors.background }} />;
  const size = downloadSize(s.faces, allowed && explicit ? "laion-b32" : "mobileclip-s2", here);
  // what this phone would download for each model: all of it if it indexes, only the text side if it only searches
  const need = (c: "mobileclip-s2" | "laion-b32") => { const n = downloadSize(s.faces, c, here); return n ? `a ${mb(n)} download` : "already on this phone"; };
  const moveHere = async () => {
    setBusy(true); setError(undefined);
    try { await indexHere(libraryItems()); } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } finally { setBusy(false); }
  };
  const switchExplicit = async (on: boolean) => {
    setBusy(true); setError(undefined);
    try { await setExplicit(on); setExplicitState(on); restart(); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } finally { setBusy(false); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <Appbar.Header style={{ backgroundColor: t.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
        <Appbar.Content title="Search and people" titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 32 }}>
        <View style={[st.card, { backgroundColor: s.enabled ? t.colors.primaryContainer : t.colors.surfaceVariant }]}>
          <View style={st.row}>
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium">Search what's in your photos</Text>
              <Text variant="bodySmall" style={{ color: t.colors.onSurfaceVariant, marginTop: 2 }}>
                {!s.enabled ? "Off" : p.phase === "download" ? `Downloading models · ${mb(p.done)} of ${mb(p.total)}`
                  : p.phase === "waitWifi" ? "Waiting for Wi-Fi to download the models"
                  : p.phase === "indexing" ? `Indexing for search · ${p.done} of ${p.total}`
                  : p.phase === "ready" ? `Ready · ${p.total} photos and videos`
                  : p.phase === "error" ? `Stopped: ${p.message}` : "Getting ready…"}
              </Text>
            </View>
            {busy ? <ActivityIndicator /> : <Switch value={s.enabled} onValueChange={(v) => (v ? turnOn() : setOff(true))} accessibilityLabel="Search what's in your photos" />}
          </View>
          {s.enabled && (p.phase === "download" || p.phase === "indexing") ? (
            <ProgressBar progress={p.total ? p.done / p.total : 0} color={t.colors.primary} style={{ height: 5, borderRadius: 3, marginTop: 12, backgroundColor: t.colors.outlineVariant }} />
          ) : null}
          {s.enabled && (p.phase === "waitWifi" || p.phase === "error") ? (
            <Button mode="contained" style={{ marginTop: 12, alignSelf: "flex-start" }} onPress={() => (p.phase === "waitWifi" ? change({ wifiOnly: false }) : restart())}>
              {p.phase === "waitWifi" ? `Download now (${mb(size)})` : "Try again"}
            </Button>
          ) : null}
          {!s.enabled ? (
            <Text variant="bodySmall" style={{ marginTop: 8, color: t.colors.onSurfaceVariant }}>
              {allowed
                ? `Needs a one-time download from your Cipherfilm server: standard search ${need("mobileclip-s2")}, explicit search ${need("laion-b32")}. You choose when you turn it on.`
                : size ? `Needs a one-time download of ${mb(size)} from your Cipherfilm server.` : "The models are already on this phone."}
            </Text>
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>
        {s.enabled ? (
          <List.Item title={here ? "This phone indexes your photos" : `Indexed by ${indexer?.device || "another device"}`}
            description={here
              ? "Only one device indexes your photos for search; your other devices use its index and only download the small search model."
              : "This phone only searches: it uses what that device found and needs only the search model. Indexing here takes longer and more battery."}
            descriptionNumberOfLines={4}
            right={() => (here ? null : <Button mode="outlined" compact disabled={busy} onPress={moveHere} style={{ alignSelf: "center" }}>Index here</Button>)} />
        ) : null}

        <SwitchItem title="Find people" description="Recognise faces and group photos of the same person. You can name them." value={s.faces} onValueChange={(v) => change({ faces: v })} />
        <SwitchItem title="Download models only on Wi-Fi" value={s.wifiOnly} onValueChange={(v) => change({ wifiOnly: v })} />
        {allowed && s.enabled && explicit !== null ? (
          <SwitchItem title="Explicit search" disabled={busy}
            description={explicit
              ? "On: an uncensored model (LAION CLIP ViT-B/32) also finds explicit content. Turning it off goes back to MobileCLIP."
              : `Your admin allowed it. Uses an uncensored model (LAION CLIP ViT-B/32) that also finds explicit content; switching means ${need("laion-b32")}. Applies to all your devices; the device that indexes builds the index again.`}
            value={explicit} onValueChange={switchExplicit} />
        ) : null}

        <Divider style={{ marginTop: 8 }} />
        <List.Subheader>In the background</List.Subheader>
        <SwitchItem title="Also when the app is closed" description="Photos on this phone, about every 15 minutes when Android allows, and after a backup."
          value={s.background} onValueChange={(v) => change({ background: v }, false)} />
        <SwitchItem title="Only while charging" description="Recommended: indexing takes battery." disabled={!s.background}
          value={s.chargingOnly} onValueChange={(v) => change({ chargingOnly: v }, false)} />
        {s.background && !device.batteryExempt ? (
          <List.Item title="Run in the background" descriptionNumberOfLines={4}
            description={ownBatteryRules() ? "On Xiaomi phones: app settings › Battery saver › No restrictions." : "Android may pause indexing when the app is closed."}
            right={() => <Button mode="outlined" compact style={{ alignSelf: "center" }}
              onPress={() => { expectAway(); if (ownBatteryRules()) N.openAppSettings(); else N.askBatteryExemption(); }}>{ownBatteryRules() ? "Open" : "Allow"}</Button>} />
        ) : null}

        <Divider style={{ marginTop: 8 }} />
        <Text variant="bodySmall" style={[st.hint, { color: t.colors.onSurfaceVariant, marginTop: 12 }]}>
          Everything runs on this phone, with open models from your own server (MobileCLIP for what is in a photo, YuNet and SFace for faces). The results are encrypted before they are stored, so your other devices don't have to redo them; the server never learns what your photos show or who is in them. Photos that are only on the server are indexed while the app is open and unlocked.
        </Text>
      </ScrollView>
      <Portal>
        <Dialog visible={choose} onDismiss={() => setChoose(false)}>
          <Dialog.Title>Which search?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">Your admin allowed explicit search. Choose before the model downloads; you can change it later here. It applies to all your devices.</Text>
            <Text variant="bodyMedium" style={{ marginTop: 12 }}><Text style={{ fontWeight: "600" }}>Standard</Text> · MobileCLIP, {need("mobileclip-s2")}. Best for everyday searches.</Text>
            <Text variant="bodyMedium" style={{ marginTop: 8 }}><Text style={{ fontWeight: "600" }}>Explicit</Text> · LAION CLIP, {need("laion-b32")}. Also finds explicit content.</Text>
          </Dialog.Content>
          <Dialog.Actions style={{ flexDirection: "column", alignItems: "flex-end" }}>
            <Button onPress={() => turnOn("standard")}>Standard search</Button>
            <Button onPress={() => turnOn("explicit")}>Explicit search</Button>
            <Button onPress={() => setChoose(false)}>Cancel</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={off} onDismiss={() => setOff(false)}>
          <Dialog.Title>Turn off search?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">The models are removed from this phone. You can also delete what was found (also for your other devices); names of people are deleted with it.</Text>
          </Dialog.Content>
          <Dialog.Actions style={st.stacked}>
            <Button onPress={() => turnOff(false)}>Turn off</Button>
            <Button textColor={t.colors.error} onPress={() => turnOff(true)}>Delete everything</Button>
            <Button onPress={() => setOff(false)}>Cancel</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const st = StyleSheet.create({
  card: { margin: 16, padding: 16, borderRadius: radius.card },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  hint: { paddingHorizontal: 16, paddingVertical: 4 },
  stacked: { flexDirection: "column", alignItems: "flex-end", gap: 4 },
});
