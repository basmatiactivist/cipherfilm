import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, Divider, List, Portal, ProgressBar, Switch, Text } from "react-native-paper";
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
import { Loader } from "../Loader";

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** Search and people: on or off, faces or not, when the phone works on it, and what it keeps. */
export default function SearchSettingsScreen() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const [s, setS] = useState<SearchSettings | null>(null);
  // explicit search: offered only where an admin allowed it; the choice is the account's (docs/SEARCH.md). The
  // account is fetched again here, so a permission the admin gave since sign-in shows once it arrives. The screen
  // doesn't wait for it: it shows the account as the phone knows it, and the rows follow when the answer comes.
  const me = useSession().me;
  const allowed = !!me?.user.nsfw && explicitSearchOffered(); // never in the Play build (src/store.ts)
  const [explicit, setExplicitState] = useState<boolean | null>(null);
  // the device that computes the index, when it isn't this phone (docs/SEARCH.md "One device indexes")
  const [indexer, setIndexer] = useState<{ device: string; last_seen: number } | null>(null);
  const here = indexesHere(me);
  useEffect(() => { refreshMe().catch(() => null); }, []);
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

  const header = (
    <Appbar.Header style={{ backgroundColor: t.colors.background }}>
      <Appbar.Action icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
      <Appbar.Content title="Search and people" titleStyle={text.page} />
    </Appbar.Header>
  );
  // (the settings are read once per start, then kept in memory: this shows only for a moment, if at all)
  if (!s) return <View style={{ flex: 1, backgroundColor: t.colors.background }}>{header}<View style={st.waiting}><Loader /></View></View>;
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
      {header}
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
                  : p.phase === "error" ? `Stopped: ${p.message}`
                  : p.phase === "loading" && p.total ? `Getting search ready · ${p.done} of ${p.total}`
                  : p.phase === "loading" && p.message ? `${p.message}…` : "Getting ready…"}
              </Text>
            </View>
            {busy ? <Loader /> : <Switch value={s.enabled} onValueChange={(v) => (v ? turnOn() : setOff(true))} accessibilityLabel="Search what's in your photos" />}
          </View>
          {s.enabled && (p.phase === "download" || p.phase === "indexing" || p.phase === "loading") ? (
            // getting ready (opening the models, the server's entries) has no count yet: it moves without one
            <ProgressBar progress={p.total ? p.done / p.total : 0} indeterminate={p.phase === "loading" && !p.total} color={t.colors.primary} style={{ height: 5, borderRadius: 3, marginTop: 12, backgroundColor: t.colors.outlineVariant }} />
          ) : null}
          {s.enabled && (p.phase === "waitWifi" || p.phase === "error") ? (
            <Button mode="contained" style={{ marginTop: 12, alignSelf: "flex-start" }} onPress={() => (p.phase === "waitWifi" ? change({ wifiOnly: false }) : restart())}>
              {p.phase === "waitWifi" ? `Download now (${mb(size)})` : "Try again"}
            </Button>
          ) : null}
          {!s.enabled ? (
            <Text variant="bodySmall" style={{ marginTop: 8, color: t.colors.onSurfaceVariant }}>
              {allowed
                ? `Runs on this phone. Downloads once from Hugging Face: standard search ${need("mobileclip-s2")}, explicit search ${need("laion-b32")}. You choose when you turn it on.`
                : size ? `Runs on this phone. Downloads ${mb(size)} once from Hugging Face.` : "The models are already on this phone."}
            </Text>
          ) : null}
          {/* where the models come from, said before anything is downloaded (docs/MODELS.md) */}
          {(!s.enabled && (size || allowed)) || p.phase === "waitWifi" ? (
            <Text variant="bodySmall" style={{ marginTop: 8, color: t.colors.onSurfaceVariant }}>
              {p.phase === "waitWifi" ? "Downloaded once from Hugging Face. " : ""}Hugging Face sees this phone's IP address, nothing of your photos.
            </Text>
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>
        {s.enabled ? (
          <List.Item title={here ? "This phone indexes your photos" : `Indexed by ${indexer?.device || "another device"}`}
            description={here
              ? "Your other devices use its index and only need the small search model."
              : "This phone uses that index. Indexing here takes longer and more battery."}
            descriptionNumberOfLines={4}
            right={() => (here ? null : <Button mode="outlined" compact disabled={busy} onPress={moveHere} style={{ alignSelf: "center" }}>Index here</Button>)} />
        ) : null}

        <SwitchItem title="Find people" description="Group photos by face. You can name people." value={s.faces} onValueChange={(v) => change({ faces: v })} />
        <SwitchItem title="Download models only on Wi-Fi" value={s.wifiOnly} onValueChange={(v) => change({ wifiOnly: v })} />
        {allowed && s.enabled && explicit !== null ? (
          <SwitchItem title="Explicit search" disabled={busy}
            description={explicit
              ? "Uses an uncensored model (LAION CLIP ViT-B/32). Turn off to go back to MobileCLIP."
              : `Your admin allowed it. An uncensored model (LAION CLIP ViT-B/32) that also finds explicit content; ${need("laion-b32")}. Applies to all your devices; the index is rebuilt.`}
            value={explicit} onValueChange={switchExplicit} />
        ) : null}

        <Divider style={{ marginTop: 8 }} />
        <List.Subheader>In the background</List.Subheader>
        <SwitchItem title="Also when the app is closed" description="About every 15 minutes when Android allows, and after a backup"
          value={s.background} onValueChange={(v) => change({ background: v }, false)} />
        <SwitchItem title="Only while charging" description="Recommended. Indexing uses battery." disabled={!s.background}
          value={s.chargingOnly} onValueChange={(v) => change({ chargingOnly: v }, false)} />
        {s.background && !device.batteryExempt ? (
          <List.Item title="Run in the background" descriptionNumberOfLines={4}
            description={ownBatteryRules() ? "On Xiaomi phones: app settings › Battery saver › No restrictions." : "Android may pause indexing when the app is closed."}
            right={() => <Button mode="outlined" compact style={{ alignSelf: "center" }}
              onPress={() => { expectAway(); if (ownBatteryRules()) N.openAppSettings(); else N.askBatteryExemption(); }}>{ownBatteryRules() ? "Open" : "Allow"}</Button>} />
        ) : null}

        <Divider style={{ marginTop: 8 }} />
        <Text variant="bodySmall" style={[st.hint, { color: t.colors.onSurfaceVariant, marginTop: 12 }]}>
          Runs on this phone with open models (MobileCLIP for content, YuNet and SFace for faces). Results are encrypted before they are stored and shared with your other devices. The server never learns what your photos show or who is in them. Photos only on the server are indexed while the app is open and unlocked.
        </Text>
      </ScrollView>
      <Portal>
        <Dialog visible={choose} onDismiss={() => setChoose(false)}>
          <Dialog.Title>Which search?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">Your admin allowed explicit search. It applies to all your devices, and you can change it later.</Text>
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
            <Text variant="bodyMedium">The models are removed from this phone. You can also delete the search data on all your devices, including the names of people.</Text>
          </Dialog.Content>
          <Dialog.Actions style={st.stacked}>
            <Button onPress={() => turnOff(false)}>Turn off</Button>
            <Button textColor={t.colors.error} onPress={() => turnOff(true)}>Turn off and delete data</Button>
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
  waiting: { flex: 1, alignItems: "center", justifyContent: "center" },
});
