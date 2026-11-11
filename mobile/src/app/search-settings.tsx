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
import { backgroundUse, ownBatteryRules, useOnReturn } from "../deviceState";
import { agreeModels, deleteModels, downloadSize, modelsOnPhone, onConsentChange, unagreed, type Clip } from "../search/models";
import { ModelConsentDialog, type ConsentAsk } from "../modelConsent";
import { loadSettings, onSettingsChange, pinAccount, saveSettings, type SearchSettings } from "../search/settings";
import { Problem, SwitchItem, useAppTheme } from "../ui";
import { radius, text } from "../tokens";
import { Loader } from "../Loader";
import { locale, t, tn } from "../i18n";

const mb = (n: number) => `${Math.round(n / 1e6).toLocaleString(locale())} MB`;
const num = (n: number) => n.toLocaleString(locale());

/** Search and people: on or off, faces or not, when the phone works on it, and what it keeps. */
export default function SearchSettingsScreen() {
  const th = useAppTheme();
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
      .then((r) => setIndexer(r.sessions.find((x) => x.indexer) ?? { device: "", last_seen: 0 }), () => setIndexer({ device: "", last_seen: 0 }));
  }, [here, me?.indexer]);
  const [error, setError] = useState<string>();
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState(() => N.backupState());
  const p = useSearchProgress();
  useOnReturn(() => setDevice(N.backupState())); // back from Android's settings
  const [, setConsentTick] = useState(0);
  useEffect(() => {
    loadSettings().then(setS);
    const a = onSettingsChange(() => loadSettings().then(setS));
    const b = onConsentChange(() => setConsentTick((n) => n + 1));
    return () => { a(); b(); };
  }, []);

  // before anything is downloaded from Hugging Face, the question (modelConsent.tsx); then what was asked for goes on
  const [ask, setAsk] = useState<(ConsentAsk & { then: () => void }) | null>(null);
  const withConsent = (a: ConsentAsk, then: () => void) => { if (unagreed(a.faces, a.clip, a.indexes).length) setAsk({ ...a, then }); else then(); };

  const restart = () => { startSearch(libraryItems()).catch(() => {}); };
  const change = async (patch: Partial<SearchSettings>, again = true) => {
    setError(undefined);
    try {
      await saveSettings(patch);
      await scheduleBackground();
      if (again) restart();
    } catch (e) { setError(e instanceof Error ? e.message : t("That didn't work.")); }
  };

  // where explicit search is allowed, the model is chosen before anything downloads (it can be changed later)
  const [choose, setChoose] = useState(false);
  const turnOn = async (model?: "standard" | "explicit", agreed = false) => {
    if (!model && !agreed) {
      setBusy(true);
      // the permission as it is now, then always the question where it is allowed
      const now = await refreshMe().catch(() => session().me);
      setBusy(false);
      if (now?.user.nsfw && explicitSearchOffered()) { loadPeople().then((d) => setExplicitState(!!d.explicit), () => {}); setChoose(true); return; }
    }
    setChoose(false);
    const clip: Clip = model === "explicit" ? "laion-b32" : "mobileclip-s2";
    if (!agreed && s && unagreed(s.faces, clip, here).length) { setAsk({ faces: s.faces, clip, indexes: here, then: () => turnOn(model, true) }); return; }
    setBusy(true); setError(undefined);
    try {
      const { me, masterKey } = session();
      if (!me || !masterKey) throw new Error(t("Unlock your library first."));
      if (model) { const on = model === "explicit"; await setExplicit(on); setExplicitState(on); }
      await saveSettings({ enabled: true, asked: true, ...(await pinAccount(me, server(), masterKey)) });
      await scheduleBackground();
      restart();
    } catch (e) { setError(e instanceof Error ? e.message : t("That didn't work.")); } finally { setBusy(false); }
  };
  const turnOff = async (clear: boolean) => {
    setOff(false); setBusy(true);
    try {
      stopSearch();
      await saveSettings({ enabled: false, asked: true });
      await scheduleBackground();
      await forgetSearch(clear);
      deleteModels();
    } catch (e) { setError(e instanceof Error ? e.message : t("That didn't work.")); } finally { setBusy(false); }
  };

  const header = (
    <Appbar.Header style={{ backgroundColor: th.colors.background }}>
      <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
      <Appbar.Content title={t("Search and people")} titleStyle={text.page} />
    </Appbar.Header>
  );
  // (the settings are read once per start, then kept in memory: this shows only for a moment, if at all)
  if (!s) return <View style={{ flex: 1, backgroundColor: th.colors.background }}>{header}<View style={st.waiting}><Loader /></View></View>;
  const current: Clip = allowed && explicit ? "laion-b32" : "mobileclip-s2";
  const size = downloadSize(s.faces, current, here);
  const onPhone = modelsOnPhone();
  // what this phone would download for each model: all of it if it indexes, only the text side if it only searches
  const need = (c: "mobileclip-s2" | "laion-b32") => { const n = downloadSize(s.faces, c, here); return n ? t("a {size} download", { size: mb(n) }) : t("already on this phone"); };
  const moveHere = () => withConsent({ faces: s.faces, clip: current, indexes: true }, moveHereNow);
  const moveHereNow = async () => {
    setBusy(true); setError(undefined);
    try { await indexHere(libraryItems()); } catch (e) { setError(e instanceof Error ? e.message : t("That didn't work.")); } finally { setBusy(false); }
  };
  const switchExplicit = (on: boolean) => (on ? withConsent({ faces: s.faces, clip: "laion-b32", indexes: here }, () => switchExplicitNow(true)) : switchExplicitNow(false));
  const switchExplicitNow = async (on: boolean) => {
    setBusy(true); setError(undefined);
    try { await setExplicit(on); setExplicitState(on); restart(); }
    catch (e) { setError(e instanceof Error ? e.message : t("That didn't work.")); } finally { setBusy(false); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      {header}
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 32 }}>
        <View style={[st.card, { backgroundColor: s.enabled ? th.colors.primaryContainer : th.colors.surfaceVariant }]}>
          <View style={st.row}>
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium">{t("Search what's in your photos")}</Text>
              <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant, marginTop: 2 }}>
                {!s.enabled ? t("Off") : p.phase === "consent" ? t("Waiting for your OK to download the models ({size})", { size: mb(p.total) })
                  : p.phase === "download" ? t("Downloading models · {done} of {total}", { done: mb(p.done), total: mb(p.total) })
                  : p.phase === "waitWifi" ? t("Waiting for Wi-Fi to download the models")
                  : p.phase === "indexing" ? t("Indexing for search · {done} of {total}", { done: num(p.done), total: num(p.total) })
                  : p.phase === "ready" ? tn(p.total, "Ready · {n} photo or video", "Ready · {n} photos and videos")
                  : p.phase === "error" ? t("Stopped: {message}", { message: p.message ?? "" })
                  : p.phase === "loading" && p.total ? t("Getting search ready · {done} of {total}", { done: num(p.done), total: num(p.total) })
                  : p.phase === "loading" && p.message ? `${p.message}…` : t("Getting ready…")}
              </Text>
            </View>
            {busy ? <Loader /> : <Switch value={s.enabled} onValueChange={(v) => (v ? turnOn() : setOff(true))} accessibilityLabel={t("Search what's in your photos")} />}
          </View>
          {s.enabled && (p.phase === "download" || p.phase === "indexing" || p.phase === "loading") ? (
            // getting ready (opening the models, the server's entries) has no count yet: it moves without one
            <ProgressBar progress={p.total ? p.done / p.total : 0} indeterminate={p.phase === "loading" && !p.total} color={th.colors.primary} style={{ height: 5, borderRadius: 3, marginTop: 12, backgroundColor: th.colors.outlineVariant }} />
          ) : null}
          {s.enabled && p.phase === "consent" ? (
            <Button mode="contained" style={{ marginTop: 12, alignSelf: "flex-start" }} onPress={() => setAsk({ faces: s.faces, clip: current, indexes: here, then: restart })}>
              {t("Download…")}
            </Button>
          ) : null}
          {s.enabled && (p.phase === "waitWifi" || p.phase === "error") ? (
            <Button mode="contained" style={{ marginTop: 12, alignSelf: "flex-start" }} onPress={() => (p.phase === "waitWifi" ? change({ wifiOnly: false }) : restart())}>
              {p.phase === "waitWifi" ? t("Download now ({size})", { size: mb(size) }) : t("Try again")}
            </Button>
          ) : null}
          {!s.enabled ? (
            <Text variant="bodySmall" style={{ marginTop: 8, color: th.colors.onSurfaceVariant }}>
              {allowed
                ? t("Runs on this phone. Downloads once from Hugging Face: standard search {standard}, explicit search {explicit}. You choose when you turn it on.", { standard: need("mobileclip-s2"), explicit: need("laion-b32") })
                : size ? t("Runs on this phone. Downloads {size} once from Hugging Face.", { size: mb(size) }) : t("The models are already on this phone.")}
            </Text>
          ) : null}
          {/* where the models come from, said before anything is downloaded (docs/MODELS.md) */}
          {(!s.enabled && (size || allowed)) || p.phase === "waitWifi" ? (
            <Text variant="bodySmall" style={{ marginTop: 8, color: th.colors.onSurfaceVariant }}>
              {p.phase === "waitWifi" ? t("Downloaded once from Hugging Face. Hugging Face sees this phone's IP address, nothing of your photos.") : t("Hugging Face sees this phone's IP address, nothing of your photos. You're asked before anything is downloaded.")}
            </Text>
          ) : null}
          {/* the models already here: where from, when, how big (docs/MODELS.md) */}
          {onPhone ? (
            <Text variant="bodySmall" style={{ marginTop: 8, color: th.colors.onSurfaceVariant }}>
              {onPhone.at
                ? t("Models downloaded from Hugging Face on {date}, {size}.", { date: new Date(onPhone.at).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" }), size: mb(onPhone.bytes) })
                : t("Models downloaded from Hugging Face, {size}.", { size: mb(onPhone.bytes) })}
            </Text>
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>
        {s.enabled ? (
          <List.Item title={here ? t("This phone indexes your photos") : indexer?.device ? t("Indexed by {device}", { device: indexer.device }) : t("Indexed by another device")}
            description={here
              ? t("Your other devices use its index and only need the small search model.")
              : t("This phone uses that index. Indexing here takes longer and more battery.")}
            descriptionNumberOfLines={4}
            right={() => (here ? null : <Button mode="outlined" compact disabled={busy} onPress={moveHere} style={{ alignSelf: "center" }}>{t("Index here")}</Button>)} />
        ) : null}

        <SwitchItem title={t("Find people")} description={t("Group photos by face. You can name people.")} value={s.faces}
          onValueChange={(v) => (v && s.enabled ? withConsent({ faces: true, clip: current, indexes: here }, () => change({ faces: true })) : change({ faces: v }))} />
        <SwitchItem title={t("Download models only on Wi-Fi")} value={s.wifiOnly} onValueChange={(v) => change({ wifiOnly: v })} />
        {allowed && s.enabled && explicit !== null ? (
          <SwitchItem title={t("Explicit search")} disabled={busy}
            description={explicit
              ? t("Uses an uncensored model (LAION CLIP ViT-B/32). Turn off to go back to MobileCLIP.")
              : t("Your admin allowed it. An uncensored model (LAION CLIP ViT-B/32) that also finds explicit content; {size}. Applies to all your devices; the index is rebuilt.", { size: need("laion-b32") })}
            value={explicit} onValueChange={switchExplicit} />
        ) : null}

        <Divider style={{ marginTop: 8 }} />
        <List.Subheader>{t("In the background")}</List.Subheader>
        <SwitchItem title={t("Also when the app is closed")} description={t("About every 15 minutes when Android allows, and after a backup")}
          value={s.background} onValueChange={(v) => change({ background: v }, false)} />
        <SwitchItem title={t("Only while charging")} description={t("Recommended. Indexing uses battery.")} disabled={!s.background}
          value={s.chargingOnly} onValueChange={(v) => change({ chargingOnly: v }, false)} />
        {/* only where Android stops it ("Restricted"), or on Xiaomi, whose own battery saver the app can't see; Android's
            default ("Optimized") lets it run, as the Backup screen says too (deviceState.ts backgroundUse) */}
        {s.background && (backgroundUse(device) === "restricted" || (ownBatteryRules() && !device.batteryExempt)) ? (
          <List.Item title={t("Run in the background")} descriptionNumberOfLines={4}
            description={backgroundUse(device) === "restricted" ? t("Android stops indexing when the app is closed. In the app settings, open Battery and allow background usage.") : t("On Xiaomi phones: app settings › Battery saver › No restrictions.")}
            right={() => <Button mode="outlined" compact style={{ alignSelf: "center" }}
              onPress={() => { expectAway(); N.openAppSettings(); }}>{t("Open")}</Button>} />
        ) : null}

        <Divider style={{ marginTop: 8 }} />
        <Text variant="bodySmall" style={[st.hint, { color: th.colors.onSurfaceVariant, marginTop: 12 }]}>
          {t("Runs on this phone with open models (MobileCLIP for content, YuNet and SFace for faces). Results are encrypted before they are stored and shared with your other devices. The server never learns what your photos show or who is in them. Photos only on the server are indexed while the app is open and unlocked.")}
        </Text>
        <Text variant="bodySmall" style={[st.hint, { color: th.colors.onSurfaceVariant, marginTop: 8 }]}>
          {t("Hugging Face is a trademark of Hugging Face, Inc. Cipherfilm is not affiliated with or endorsed by Hugging Face.")}
        </Text>
      </ScrollView>
      <ModelConsentDialog ask={ask} wifiOnly={s.wifiOnly}
        onYes={() => { if (!ask) return; agreeModels(ask.faces, ask.clip, ask.indexes); const go = ask.then; setAsk(null); go(); }}
        onLater={() => setAsk(null)} />
      <Portal>
        <Dialog visible={choose} onDismiss={() => setChoose(false)}>
          <Dialog.Title>{t("Which search?")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("Your admin allowed explicit search. It applies to all your devices, and you can change it later.")}</Text>
            <Text variant="bodyMedium" style={{ marginTop: 12 }}><Text style={{ fontWeight: "600" }}>{t("Standard")}</Text> · {t("MobileCLIP, {size}. Best for everyday searches.", { size: need("mobileclip-s2") })}</Text>
            <Text variant="bodyMedium" style={{ marginTop: 8 }}><Text style={{ fontWeight: "600" }}>{t("Explicit")}</Text> · {t("LAION CLIP, {size}. Also finds explicit content.", { size: need("laion-b32") })}</Text>
          </Dialog.Content>
          <Dialog.Actions style={{ flexDirection: "column", alignItems: "flex-end" }}>
            <Button onPress={() => turnOn("standard")}>{t("Standard search")}</Button>
            <Button onPress={() => turnOn("explicit")}>{t("Explicit search")}</Button>
            <Button onPress={() => setChoose(false)}>{t("Cancel")}</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={off} onDismiss={() => setOff(false)}>
          <Dialog.Title>{t("Turn off search?")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("The models are deleted from this phone; turning search on again asks before downloading them. You can also delete the search data on all your devices, including the names of people.")}</Text>
          </Dialog.Content>
          <Dialog.Actions style={st.stacked}>
            <Button onPress={() => turnOff(false)}>{t("Turn off")}</Button>
            <Button textColor={th.colors.error} onPress={() => turnOff(true)}>{t("Turn off and delete data")}</Button>
            <Button onPress={() => setOff(false)}>{t("Cancel")}</Button>
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
