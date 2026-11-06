import { useCallback, useEffect, useState } from "react";
import { AppState, PermissionsAndroid, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { ActivityIndicator, Appbar, Button, Divider, List, RadioButton, Switch, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N, { type BackupState } from "../../modules/cf-native/src/CfNativeModule";
import { blocker, chooseFolders, disableBackup, enableBackup, loadConfig, loadStatus, notBackedUp, onBackupChange, rememberLibrary, runBackup, saveConfig, startAfter, waitingCount, type Config, type Status } from "../backup";
import { server } from "../api";
import { libraryItems, refreshLibrary } from "../libraryStore";
import { session } from "../session";
import { Icon, type IconName } from "../icons";
import { Problem, SwitchItem, useAppTheme } from "../ui";
import { radius, text } from "../tokens";
import { useMediaDisclosure } from "../disclosure";
import { isPlayBuild } from "../store";

type MediaFolder = Awaited<ReturnType<typeof N.mediaFolders>>[number];
const fmtTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const DEFAULTS = { wifiOnly: true, chargingOnly: false, includeExisting: false };

/** Automatic backup: which folders, when, and the Android settings it needs, each with its state and a button. */
export default function Backup() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const [config, setConfig] = useState<Config | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [device, setDevice] = useState<BackupState>(() => N.backupState());
  const [folders, setFolders] = useState<MediaFolder[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [prefs, setPrefs] = useState(DEFAULTS);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [older, setOlder] = useState(0); // from before the backup's start in these folders, and not in the library
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const disclosure = useMediaDisclosure();

  const refresh = useCallback(async () => {
    const st = N.backupState();
    setDevice(st);
    const c = await loadConfig();
    setConfig(c);
    setStatus(await loadStatus());
    if (c) { setPrefs({ wifiOnly: c.wifiOnly, chargingOnly: c.chargingOnly, includeExisting: c.includeExisting }); setChosen(new Set(Object.keys(c.folders))); }
    if (st.media !== "none") {
      // the app's own saved copies (Pictures/Cipherfilm) are already in the library
      const f = (await N.mediaFolders().catch(() => [])).filter((x) => !/^Pictures\/Cipherfilm\/?$/.test(x.path));
      setFolders(f);
      // first visit: the camera folders are ticked
      if (!c) setChosen((cur) => (cur.size ? cur : new Set(f.filter((x) => x.path.startsWith("DCIM/")).map((x) => x.id))));
    }
    setWaiting(c?.enabled ? await waitingCount() : null);
    setOlder(c?.enabled && !c.includeExisting ? await notBackedUp().catch(() => 0) : 0);
  }, []);

  useEffect(() => {
    refresh();
    const a = AppState.addEventListener("change", (s) => { if (s === "active") refresh(); }); // back from Android's settings
    const b = onBackupChange(() => { refresh(); });
    return () => { a.remove(); b(); };
  }, [refresh]);

  const on = !!config?.enabled;

  /** Saves a change of folders or conditions. "Photos already on the phone" applies to every chosen folder. */
  const apply = async (next: Set<string>, p = prefs) => {
    setChosen(next); setPrefs(p);
    // read fresh, not from the screen: a run moves the folders' places on meanwhile
    const cur = await loadConfig();
    if (!cur) return;
    const c = { ...cur, ...p, folders: chooseFolders(cur, next, p.includeExisting, folders ?? []) };
    await saveConfig(c);
    setConfig(c);
    setWaiting(c.enabled ? await waitingCount() : null);
    setOlder(c.enabled && !c.includeExisting ? await notBackedUp().catch(() => 0) : 0);
    if (c.enabled && p.includeExisting && !cur.includeExisting) runBackup("app").catch(() => {});
  };

  // the disclosure first, then Android's prompt (on Android 14, with "only some" again: it lets the person change which)
  const askMedia = async () => {
    await disclosure.ask("backup");
    await refresh();
  };
  const askNotifications = async () => {
    // before Android 13 there is no prompt: notifications are switched off in the app settings
    if (device.sdk < 33) { N.openAppSettings(); return; }
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) N.openAppSettings();
    await refresh();
  };

  const toggle = async () => {
    setError(undefined); setBusy(true);
    try {
      if (on) { await disableBackup(); return; }
      if (device.media === "none") { await askMedia(); if (N.backupState().media === "none") throw new Error("Allow access to photos and videos first."); }
      const { me, masterKey } = session();
      if (!me || !masterKey) throw new Error("Unlock your library first.");
      const list = folders ?? (await N.mediaFolders()).filter((x) => !/^Pictures\/Cipherfilm\/?$/.test(x.path));
      let ids = chosen.size ? chosen : new Set(list.filter((x) => x.path.startsWith("DCIM/")).map((x) => x.id));
      if (!ids.size) throw new Error("Choose at least one folder to back up.");
      const byId = new Map(list.map((f) => [f.id, f]));
      const fs: Config["folders"] = {};
      for (const id of ids) fs[id] = { name: byId.get(id)?.name ?? "Folder", after: startAfter(prefs.includeExisting, byId.get(id)?.newest ?? 0) };
      await enableBackup(me, server(), masterKey, { ...prefs, folders: fs });
      // what the library already has, before the first run: those photos aren't uploaded again
      await refreshLibrary();
      await rememberLibrary(me.user.id, libraryItems());
      if (!N.backupState().notifications) await askNotifications();
      runBackup("app").catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const now = config ? blocker(config, false) : undefined;
  const problem = status?.problem ?? (on ? now : undefined);

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <Appbar.Header style={{ backgroundColor: t.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
        <Appbar.Content title="Backup" titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 32 }}>
        <View style={[st.card, { backgroundColor: on ? t.colors.primaryContainer : t.colors.surfaceVariant }]}>
          <View style={st.row}>
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium">Back up automatically</Text>
              <Text variant="bodySmall" style={{ color: t.colors.onSurfaceVariant, marginTop: 2 }}>
                {on ? (status?.running ? `Backing up${status.current ? ` ${status.current}` : ""}…` : waiting ? `${waiting} waiting`
                  : older ? "New photos and videos are backed up" : device.media === "partial" ? "Everything Cipherfilm may see is backed up" : "Everything is backed up") : "Off"}
              </Text>
            </View>
            {busy ? <ActivityIndicator /> : <Switch value={on} onValueChange={toggle} accessibilityLabel="Back up automatically" />}
          </View>
          {on ? (
            <>
              {problem ? <Text variant="bodyMedium" style={{ marginTop: 12 }}>{problem}{status?.problem && status.problemAt ? ` (${fmtTime.format(status.problemAt)})` : ""}</Text> : null}
              {older > 0 && !status?.running ? (
                <>
                  <Text variant="bodyMedium" style={{ marginTop: 12 }}>
                    {older === 1 ? "1 older photo or video" : `${older} older photos and videos`} in these folders {older === 1 ? "isn't" : "aren't"} in Cipherfilm. Only new ones are backed up.
                  </Text>
                  <Button mode="outlined" style={{ marginTop: 8, alignSelf: "flex-start" }} onPress={() => apply(chosen, { ...prefs, includeExisting: true })}>Back up these too</Button>
                </>
              ) : null}
              {status?.stalled && !status.running ? <Text variant="bodyMedium" style={{ marginTop: 12 }}>The last backup stopped while working on {status.stalled}. It is tried again, at most three times, then skipped.</Text> : null}
              <Text variant="bodySmall" style={{ marginTop: 8, color: t.colors.onSurfaceVariant }}>
                {status?.lastDone ? `Last complete: ${fmtTime.format(status.lastDone)}` : status?.lastRun ? `Last checked: ${fmtTime.format(status.lastRun)}` : "Not run yet"}
                {status?.uploaded ? ` · ${status.uploaded} backed up so far` : ""}
              </Text>
              <Button mode="contained" icon="upload" style={{ marginTop: 12, alignSelf: "flex-start" }} disabled={status?.running}
                onPress={() => runBackup("manual").catch(() => {})}>Back up now</Button>
            </>
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>
        {disclosure.dialog}

        <List.Subheader>Android settings</List.Subheader>
        <Check ok={device.media === "full"} warn={device.media === "partial"} icon="photos" title="Access to photos and videos"
          text={device.media === "full" ? "Allowed" : device.media === "partial" ? "Only the photos you chose are backed up, and new photos aren't found. Choose \"Allow all\" for automatic backup." : "Needed to find new photos"}
          action={device.media === "full" ? undefined : [device.media === "partial" ? "Change" : "Allow", askMedia]} />
        {device.sdk >= 29 ? <Check ok={device.location} icon="info" title="Where photos were taken"
          text={device.location ? "Kept in the backup (encrypted)" : "Without this, Android removes the location from photos before the app sees them"}
          action={device.location ? undefined : ["Allow", askMedia]} /> : null}
        <Check ok={device.batteryExempt} icon="lock" title="Run in the background"
          text={device.batteryExempt ? "Android lets the backup run when the app is closed" : "Battery optimisation pauses the backup when the app is closed"}
          action={device.batteryExempt ? undefined : ["Allow", () => N.askBatteryExemption()]} />
        {!device.batteryExempt && isPlayBuild() ? (
          <Text variant="bodySmall" style={[st.hint, { color: t.colors.onSurfaceVariant }]}>
            "Allow" opens Android's battery optimisation list: choose "All apps", then Cipherfilm, then "Don't optimise".
          </Text>
        ) : null}
        <Check ok={device.notifications} icon="upload" title="Notifications"
          text={device.notifications ? "You see the progress while it backs up" : "Shows the progress, and tells you if you need to sign in again"}
          action={device.notifications ? undefined : ["Allow", askNotifications]} />
        <Text variant="bodySmall" style={[st.hint, { color: t.colors.onSurfaceVariant }]}>
          Samsung, Xiaomi, Huawei, OPPO, OnePlus and some other phones have their own battery rules: open the app settings, then Battery, and choose "Unrestricted" or "Allow background activity".
        </Text>
        <Button mode="text" style={{ alignSelf: "flex-start", marginLeft: 8 }} onPress={() => N.openAppSettings()}>Open app settings</Button>
        {device.powerSave ? <Text variant="bodySmall" style={[st.hint, { color: t.colors.error }]}>Battery saver is on: Android delays background work until it is off.</Text> : null}

        <Divider style={{ marginTop: 8 }} />
        <List.Subheader>Folders to back up</List.Subheader>
        {device.media === "none" ? (
          <Text variant="bodyMedium" style={st.hint}>Allow access to photos and videos to see your folders.</Text>
        ) : !folders ? <ActivityIndicator style={{ margin: 16 }} /> : folders.map((f) => (
          <List.Item key={f.id} title={f.name} description={`${f.path.replace(/\/$/, "")} · ${f.count === 1 ? "1 item" : `${f.count} items`}`}
            onPress={() => { const n = new Set(chosen); n.has(f.id) ? n.delete(f.id) : n.add(f.id); apply(n); }}
            accessibilityRole="checkbox" accessibilityState={{ checked: chosen.has(f.id) }}
            left={() => <View style={{ justifyContent: "center", paddingLeft: 16, paddingRight: 4 }}><Icon name={chosen.has(f.id) ? "boxOn" : "boxOff"} size={24} color={chosen.has(f.id) ? t.colors.primary : t.colors.onSurfaceVariant} /></View>}
            style={{ paddingVertical: 2 }} />
        ))}

        <Divider style={{ marginTop: 8 }} />
        <List.Subheader>Photos already on the phone</List.Subheader>
        <RadioButton.Group value={prefs.includeExisting ? "all" : "new"} onValueChange={(v) => apply(chosen, { ...prefs, includeExisting: v === "all" })}>
          <RadioButton.Item label="Only new photos and videos from now on" value="new" labelVariant="bodyLarge" />
          <RadioButton.Item label="Also the ones already in these folders" value="all" labelVariant="bodyLarge" />
        </RadioButton.Group>
        <Text variant="bodySmall" style={[st.hint, { color: t.colors.onSurfaceVariant }]}>
          Applies to all chosen folders. Photos that are already in your library (same name and size) are skipped.
        </Text>

        <Divider style={{ marginTop: 8 }} />
        <List.Subheader>When</List.Subheader>
        <SwitchItem title="Only on Wi-Fi" description="No mobile data is used" value={prefs.wifiOnly} onValueChange={(v) => apply(chosen, { ...prefs, wifiOnly: v })} />
        <SwitchItem title="Only while charging" value={prefs.chargingOnly} onValueChange={(v) => apply(chosen, { ...prefs, chargingOnly: v })} />

        {status?.skipped.length ? (
          <>
            <Divider style={{ marginTop: 8 }} />
            <List.Subheader>Couldn't be backed up</List.Subheader>
            {status.skipped.slice(0, 10).map((s, i) => <List.Item key={i} title={s.name} description={s.reason} descriptionNumberOfLines={2} />)}
          </>
        ) : null}

        <Divider style={{ marginTop: 8 }} />
        <Text variant="bodySmall" style={[st.hint, { color: t.colors.onSurfaceVariant, marginTop: 12 }]}>
          Photos are encrypted on this phone before they leave it. The background backup only holds your account's public key: it can add photos to your library but can't open any. It starts a few seconds after you take a photo, about every 15 minutes besides when Android allows, and when you open the app; once it runs, it goes on until everything is uploaded.
        </Text>
      </ScrollView>
    </View>
  );
}

function Check({ ok, warn, icon, title, text, action }: { ok: boolean; warn?: boolean; icon: IconName; title: string; text: string; action?: [string, () => void] }) {
  const t = useAppTheme();
  return (
    <List.Item title={title} description={text} descriptionNumberOfLines={3} titleNumberOfLines={2}
      left={() => (
        <View style={[st.dot, { backgroundColor: ok ? t.colors.primaryContainer : warn ? t.colors.tertiaryContainer : t.colors.errorContainer }]}>
          <Icon name={ok ? "check" : icon} size={18} color={ok ? t.colors.primary : warn ? t.colors.tertiary : t.colors.error} />
        </View>
      )}
      right={() => (action ? <Button mode="outlined" compact onPress={action[1]} style={{ alignSelf: "center" }}>{action[0]}</Button> : null)} />
  );
}

const st = StyleSheet.create({
  card: { margin: 16, padding: 16, borderRadius: radius.card },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  hint: { paddingHorizontal: 16, paddingVertical: 4 },
  dot: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", alignSelf: "center", marginLeft: 8 },
});
