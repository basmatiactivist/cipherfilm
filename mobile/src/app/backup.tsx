import { useEffect, useMemo, useState } from "react";
import { AppState, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Divider, List, ProgressBar, RadioButton, Switch, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N, { type BackupState } from "../../modules/cf-native/src/CfNativeModule";
import { DEMO_BACKUP, backupProgress, blocker, chooseFolders, disableBackup, enableBackup, loadConfig, loadStatus, notBackedUp, onBackupChange, onBackupProgress, rememberLibrary, runBackup, saveConfig, startAfter, waitingCount, type Config, type Status } from "../backup";
import { existingChoice, folderLine, headline, lastLine, liveLine, tooLarge } from "../backupText";
import { coalesce } from "../coalesce";
import { server } from "../api";
import { libraryItems, refreshLibrary } from "../libraryStore";
import { session } from "../session";
import { Icon, type IconName } from "../icons";
import { Problem, SwitchItem, useAppTheme } from "../ui";
import { radius, text } from "../tokens";
import { useMediaDisclosure } from "../disclosure";
import { expectAway } from "../autolock";
import { requestNotifications } from "../mediaAccess";
import { backgroundUse, ownBatteryRules, useOnReturn } from "../deviceState";
import { Loader, Loading } from "../Loader";
import { locale, t } from "../i18n";

type MediaFolder = Awaited<ReturnType<typeof N.mediaFolders>>[number];
const fmtTime = { format: (d: number) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(d) };

const DEFAULTS = { wifiOnly: true, chargingOnly: false, includeExisting: false };

/** Automatic backup: which folders, when, and the Android settings it needs, each with its state and a button. */
export default function Backup() {
  const theme = useAppTheme();
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
  const [live, setLive] = useState(backupProgress); // n of m, what is left and how fast, while a run uploads
  const disclosure = useMediaDisclosure();
  // what Android allows, again on coming back from its settings (and a moment later, when Android catches up)
  useOnReturn(() => setDevice(N.backupState()));
  const xiaomi = ownBatteryRules();

  // The whole screen: folders and counts query the phone's photo library. One at a time (coalesce): a running backup
  // changes its status several times per file.
  const refresh = useMemo(() => coalesce(async () => {
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
  }), []);
  // While a run goes on only its status, which is cheap: the counts again once it is over. Before, every change
  // reloaded the whole screen and its library queries held up the run they were showing.
  const follow = useMemo(() => coalesce(async () => {
    const st = await loadStatus();
    setStatus(st);
    if (!st.running) await refresh();
  }), [refresh]);

  useEffect(() => {
    refresh();
    const a = AppState.addEventListener("change", (s) => { if (s === "active") refresh(); }); // the backup may have run meanwhile
    const b = onBackupChange(() => { follow(); });
    const c = onBackupProgress(() => setLive(backupProgress()));
    return () => { a.remove(); b(); c(); };
  }, [refresh, follow]);

  const on = !!config?.enabled;

  /** Saves a change of folders or conditions. "Photos and videos already on this phone" applies to every chosen folder. */
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
  const appSettings = () => { expectAway(); N.openAppSettings(); };
  const askNotifications = async () => {
    // the backup's own notifications switched off counts as not allowed (mediaAccess.ts)
    await requestNotifications(() => N.backupState().notifications);
    await refresh();
  };

  const toggle = async () => {
    setError(undefined); setBusy(true);
    try {
      if (on) { await disableBackup(); return; }
      if (session().me?.demo) throw new Error(DEMO_BACKUP()); // before Android asks for the photos
      if (device.media === "none") { await askMedia(); if (N.backupState().media === "none") throw new Error(t("Allow access to photos and videos first.")); }
      const { me, masterKey } = session();
      if (!me || !masterKey) throw new Error(t("Unlock your library first."));
      const list = folders ?? (await N.mediaFolders()).filter((x) => !/^Pictures\/Cipherfilm\/?$/.test(x.path));
      let ids = chosen.size ? chosen : new Set(list.filter((x) => x.path.startsWith("DCIM/")).map((x) => x.id));
      if (!ids.size) throw new Error(t("Choose at least one folder to back up."));
      const byId = new Map(list.map((f) => [f.id, f]));
      const fs: Config["folders"] = {};
      for (const id of ids) fs[id] = { name: byId.get(id)?.name ?? t("Folder"), after: startAfter(prefs.includeExisting, byId.get(id)?.newest ?? 0) };
      await enableBackup(me, server(), masterKey, { ...prefs, folders: fs });
      // what the library already has, before the first run: those photos aren't uploaded again
      await refreshLibrary();
      await rememberLibrary(me.user.id, libraryItems());
      if (!N.backupState().notifications) await askNotifications();
      runBackup("app").catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : t("That didn't work."));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const now = config ? blocker(config, false) : undefined;
  const problem = status?.problem ?? (on ? now : undefined);
  const running = !!status?.running;
  const inFolders = (folders ?? []).filter((f) => chosen.has(f.id)).reduce((n, f) => n + f.count, 0);
  const choice = existingChoice({ on, includeExisting: prefs.includeExisting, inFolders, older });
  const background = backgroundUse(device);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header style={{ backgroundColor: theme.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Backup")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 32 }}>
        <View style={[st.card, { backgroundColor: on ? theme.colors.primaryContainer : theme.colors.surfaceVariant }]}>
          <View style={st.row}>
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium">{t("Back up automatically")}</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                {headline({ on, running, live, waiting, includeExisting: !!config?.includeExisting, older, partial: device.media === "partial" })}
              </Text>
            </View>
            {busy ? <Loader /> : <Switch value={on} onValueChange={toggle} accessibilityLabel={t("Back up automatically")} />}
          </View>
          {on ? (
            <>
              {running && live ? (
                <>
                  <ProgressBar progress={live.fraction} color={theme.colors.primary} style={{ height: 5, borderRadius: 3, marginTop: 12, backgroundColor: theme.colors.outlineVariant }} />
                  <Text variant="bodySmall" style={{ marginTop: 6, color: theme.colors.onSurfaceVariant }}>{liveLine(live)}</Text>
                </>
              ) : null}
              {problem ? <Text variant="bodyMedium" style={{ marginTop: 12 }}>{problem}{status?.problem && status.problemAt ? ` (${fmtTime.format(status.problemAt)})` : ""}</Text> : null}
              {status?.needsYou?.length && !status.running ? (
                <Text variant="bodyMedium" style={{ marginTop: 12 }}>{tooLarge(status.needsYou)}</Text>
              ) : null}
              {status?.stalled && !status.running ? <Text variant="bodyMedium" style={{ marginTop: 12 }}>{t("The last backup stopped at {name}. It is tried up to three more times, then skipped.", { name: status.stalled })}</Text> : null}
              <Text variant="bodySmall" style={{ marginTop: 8, color: theme.colors.onSurfaceVariant }}>
                {lastLine(status ?? { uploaded: 0 }, (d) => fmtTime.format(d))}
              </Text>
              <Button mode="contained" icon="upload" style={{ marginTop: 12, alignSelf: "flex-start" }} disabled={status?.running}
                onPress={() => runBackup("manual").catch(() => {})}>{t("Back up now")}</Button>
            </>
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>
        {disclosure.dialog}

        <List.Subheader>{t("Android settings")}</List.Subheader>
        <Check ok={device.media === "full"} warn={device.media === "partial"} icon="photos" title={t("Access to photos and videos")}
          text={device.media === "full" ? t("Allowed") : device.media === "partial" ? t("Only the photos you chose are backed up; new ones aren't found. Choose \"Allow all\".") : t("Needed to find new photos")}
          action={device.media === "full" ? undefined : [device.media === "partial" ? t("Change") : t("Allow"), askMedia]} />
        {device.sdk >= 29 ? <Check ok={device.location} icon="info" title={t("Where photos were taken")}
          text={device.location ? t("Kept in the backup (encrypted)") : t("Without this, Android strips the location from photos")}
          action={device.location ? undefined : [t("Allow"), askMedia]} /> : null}
        {/* Android's default ("Optimized", "Allow background usage" on) counts as allowed: the backup runs then, and
            that is what the person sees switched on in Android's settings. Only "Restricted" stops it. Xiaomi's own
            battery saver can't be seen by the app, so there it says where it is until the exemption is on. */}
        <Check ok={background === "unrestricted" || (background === "allowed" && !xiaomi)} warn={background !== "restricted"} icon="lock" title={t("Run in the background")}
          text={background === "unrestricted" ? t("Allowed, without battery limits")
            : background === "restricted" ? t("Android stops the backup when the app is closed. In the app settings, open Battery and allow background usage.")
            : xiaomi ? t("On this phone: app settings › Battery saver › No restrictions. This box stays unticked, because Android can't see that setting.")
            : t("Allowed. Android may wait a little with a backup while the phone is idle.")}
          action={background === "restricted" || (background === "allowed" && xiaomi) ? [t("Open"), appSettings] : undefined} />
        <Check ok={device.notifications} icon="upload" title={t("Notifications")}
          text={device.notifications ? t("Shows backup progress") : t("Shows progress and tells you when to sign in again")}
          action={device.notifications ? undefined : [t("Allow"), askNotifications]} />
        <Text variant="bodySmall" style={[st.hint, { color: theme.colors.onSurfaceVariant }]}>
          {t("Some phone makers have their own battery rules: in the app settings, open Battery and choose \"Unrestricted\" or \"Allow background activity\".")}
        </Text>
        <Button mode="text" style={{ alignSelf: "flex-start", marginLeft: 8 }} onPress={appSettings}>{t("Open app settings")}</Button>
        {device.powerSave ? <Text variant="bodySmall" style={[st.hint, { color: theme.colors.error }]}>{t("Battery saver is on. Android delays the backup until it's off.")}</Text> : null}

        <Divider style={{ marginTop: 8 }} />
        <List.Subheader>{t("Folders to back up")}</List.Subheader>
        {device.media === "none" ? (
          <Text variant="bodyMedium" style={st.hint}>{t("Allow access to photos and videos to see your folders.")}</Text>
        ) : !folders ? <Loading inline label={t("Looking for photo folders…")} style={{ margin: 16 }} /> : folders.map((f) => (
          <List.Item key={f.id} title={f.name} description={folderLine(f.path, f.count)}
            onPress={() => { const n = new Set(chosen); n.has(f.id) ? n.delete(f.id) : n.add(f.id); apply(n); }}
            accessibilityRole="checkbox" accessibilityState={{ checked: chosen.has(f.id) }}
            left={() => <View style={{ justifyContent: "center", paddingLeft: 16, paddingRight: 4 }}><Icon name={chosen.has(f.id) ? "boxOn" : "boxOff"} size={24} color={chosen.has(f.id) ? theme.colors.primary : theme.colors.onSurfaceVariant} /></View>}
            style={{ paddingVertical: 2 }} />
        ))}

        <Divider style={{ marginTop: 8 }} />
        <List.Subheader>{t("Photos and videos already on this phone")}</List.Subheader>
        <RadioButton.Group value={prefs.includeExisting ? "all" : "new"} onValueChange={(v) => apply(chosen, { ...prefs, includeExisting: v === "all" })}>
          <RadioButton.Item label={t("Only new photos and videos from now on")} value="new" labelVariant="bodyLarge" />
          <RadioButton.Item label={choice.all} value="all" labelVariant="bodyLarge" />
        </RadioButton.Group>
        <Text variant="bodySmall" style={[st.hint, { color: theme.colors.onSurfaceVariant }]}>{choice.hint}</Text>

        <Divider style={{ marginTop: 8 }} />
        <List.Subheader>{t("When")}</List.Subheader>
        <SwitchItem title={t("Only on Wi-Fi")} description={t("No mobile data is used")} value={prefs.wifiOnly} onValueChange={(v) => apply(chosen, { ...prefs, wifiOnly: v })} />
        <SwitchItem title={t("Only while charging")} value={prefs.chargingOnly} onValueChange={(v) => apply(chosen, { ...prefs, chargingOnly: v })} />

        {status?.skipped.length ? (
          <>
            <Divider style={{ marginTop: 8 }} />
            <List.Subheader>{t("Couldn't be backed up")}</List.Subheader>
            {status.skipped.slice(0, 10).map((s, i) => <List.Item key={i} title={s.name} description={s.reason} descriptionNumberOfLines={2} />)}
          </>
        ) : null}

        <Divider style={{ marginTop: 8 }} />
        <Text variant="bodySmall" style={[st.hint, { color: theme.colors.onSurfaceVariant, marginTop: 12 }]}>
          {t("Photos are encrypted on this phone before upload. The server only stores encrypted data. The background backup only holds your public key: it can add photos but can't open any. It runs a few seconds after you take a photo, about every 15 minutes when Android allows, and when you open the app.")}
        </Text>
      </ScrollView>
    </View>
  );
}

function Check({ ok, warn, icon, title, text, action }: { ok: boolean; warn?: boolean; icon: IconName; title: string; text: string; action?: [string, () => void] }) {
  const theme = useAppTheme();
  return (
    <List.Item title={title} description={text} descriptionNumberOfLines={3} titleNumberOfLines={2}
      left={() => (
        <View style={[st.dot, { backgroundColor: ok ? theme.colors.primaryContainer : warn ? theme.colors.tertiaryContainer : theme.colors.errorContainer }]}>
          <Icon name={ok ? "check" : icon} size={18} color={ok ? theme.colors.primary : warn ? theme.colors.tertiary : theme.colors.error} />
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
