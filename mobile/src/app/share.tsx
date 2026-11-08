import { useEffect, useRef, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { clearSharedPayloads, getSharedPayloads } from "expo-sharing";
import { useKeepAwake } from "expo-keep-awake";
import { Appbar, Button, ProgressBar, Snackbar, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N from "../../modules/cf-native/src/CfNativeModule";
import { away } from "../autolock";
import { describe, fmtSize, shareSummary, showUploads, SignedOut, uploadShared, uploadsSummary, type Shared } from "../upload";
import { anyHolder, keepRunning, letGo } from "../keepAlive";
import { useSession } from "../session";
import { refreshLibrary } from "../libraryStore";
import { takePicked } from "../pending";
import { Problem, useAppTheme } from "../ui";
import { Icon } from "../icons";
import { radius, text } from "../tokens";
import { Loader, Loading } from "../Loader";
import { locale, t, tn } from "../i18n";

interface Job { file: Shared; state: "queued" | "working" | "done" | "error"; done: number; error?: string; stopped?: boolean }
const FILES_AT_ONCE = 2;

/** Photos shared from another app: shown with the account they would go to, and once the person says so encrypted and
 *  uploaded here, then (if they want) removed from the phone. Picked files (Upload in Photos) start at once. */
export default function ShareScreen() {
  const theme = useAppTheme();
  const inset = useSafeAreaInsets();
  const { phase, me } = useSession();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [problem, setProblem] = useState<string>();
  const [note, setNote] = useState<string>();
  const [finished, setFinished] = useState(false);
  const [asking, setAsking] = useState(false);
  const started = useRef(false);
  const signal = useRef({ cancelled: false });
  const shared = useRef<string[]>([]); // the share this screen shows, by its links

  // signed out or locked: sign in or unlock first, then come back here (the shared files wait)
  useEffect(() => {
    if (phase === "noServer") router.replace("/server");
    else if (phase === "signedOut") router.replace("/signin");
    else if (phase === "locked") router.replace({ pathname: "/unlock", params: { then: "share" } });
  }, [phase]);

  useEffect(() => {
    if (phase !== "unlocked" || started.current) return;
    let sources: { uri: string; hint?: Parameters<typeof describe>[1] }[];
    if (from === "picker") {
      sources = takePicked().map((uri) => ({ uri }));
    } else {
      // the raw share: the original content:// links. (Resolving them would copy every file, unencrypted, into the
      // app's cache, and lose the link that deleting from the phone needs.)
      sources = getSharedPayloads()
        .filter((p) => p.value && /^content:\/\//.test(p.value) && p.shareType !== "text" && p.shareType !== "url")
        .map((p) => ({ uri: p.value!, hint: { mime: p.mimeType } }));
      shared.current = sources.map((x) => x.uri);
    }
    if (!sources.length) { if (from === "picker") router.back(); return; }
    started.current = true;
    (async () => {
      try {
        const files = await Promise.all(sources.map((x) => describe(x.uri, x.hint)));
        const list: Job[] = files.map((file) => ({ file, state: "queued", done: 0 }));
        setJobs(list);
        // another app chose these: nothing is sent until the person has seen what and where, and taps Upload
        if (from === "picker") await run(list);
        else setAsking(true);
      } catch (e) {
        // usually the other app didn't pass on the permission to read the file (or the file is gone)
        console.log("share: couldn't read", e);
        setProblem(t("Couldn't read what was shared. Share it again, or use Upload in Photos."));
        setFinished(true);
      }
    })();
  }, [phase, from]);

  const patch = (uri: string, p: Partial<Job>) => setJobs((js) => js && js.map((j) => (j.file.uri === uri ? { ...j, ...p } : j)));

  async function run(list: Job[]) {
    const queue = [...list];
    const results = new Map<string, boolean>();
    // one notification for all of them, held from the first file to the last (not started again for each file), and
    // updated with the file, n of m and the bytes of all together
    const totalBytes = list.reduce((a, j) => a + Math.max(1, j.file.size), 0);
    const doneBytes = new Map<string, number>();
    const overall = () => [...doneBytes.values()].reduce((a, b) => a + b, 0) / totalBytes;
    let started = 0;
    keepRunning("upload", list.length === 1 ? t("Uploading to Cipherfilm") : tn(list.length, "Uploading {n} file", "Uploading {n} files"), list[0]?.file.name ?? "");
    const worker = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        const job = j;
        patch(job.file.uri, { state: "working" });
        showUploads(++started, list.length, job.file.name, overall(), true);
        try {
          await uploadShared(job.file, (done) => {
            patch(job.file.uri, { done });
            doneBytes.set(job.file.uri, done);
            showUploads(started, list.length, job.file.name, overall());
          }, signal.current);
          patch(job.file.uri, { state: "done", done: job.file.size });
          doneBytes.set(job.file.uri, Math.max(1, job.file.size));
          results.set(job.file.uri, true);
        } catch (e) {
          patch(job.file.uri, { state: "error", error: e instanceof Error ? e.message : t("Upload failed."), stopped: e instanceof SignedOut });
          doneBytes.set(job.file.uri, Math.max(1, job.file.size));
          results.set(job.file.uri, false);
          if (e instanceof SignedOut) return;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: FILES_AT_ONCE }, worker));
    } finally {
      letGo("upload");
      // the progress goes with the service; this also takes it away where Android didn't allow the service
      if (!anyHolder()) N.backupNotifyCancel();
    }
    const ok = [...results.values()].filter(Boolean).length;
    const summary = signal.current.cancelled ? null : uploadsSummary(ok, results.size - ok);
    if (summary) N.backupNotify(summary.title, summary.text, 0, false);
    forgetShare(); // handled: a lock now doesn't bring the same files up again after the unlock
    refreshLibrary();
    setFinished(true);
    // picked here: straight to Android's own confirmation (one for all, with previews), only for files that are safely
    // on the server and that Android lets us remove; failed ones always stay. A share waits for Remove from phone.
    const removable = list.filter((j) => results.get(j.file.uri) && j.file.deletable).map((j) => j.file.uri);
    if (from === "picker" && removable.length) await removeFromPhone(removable);
  }

  const upload = async () => {
    setAsking(false);
    await run(jobs ?? []);
  };

  const retry = async () => {
    const failed = (jobs ?? []).filter((j) => j.state === "error").map((j) => ({ ...j, state: "queued" as const, done: 0, error: undefined, stopped: undefined }));
    setJobs((js) => js && js.map((j) => failed.find((f) => f.file.uri === j.file.uri) ?? j));
    setFinished(false);
    await run(failed);
  };

  const all = jobs ?? [];
  const done = all.filter((j) => j.state === "done");
  const failed = all.filter((j) => j.state === "error");
  const deletable = done.filter((j) => j.file.deletable);
  const total = all.reduce((a, j) => a + Math.max(1, j.file.size), 0);
  const progress = total ? all.reduce((a, j) => a + (j.state === "done" ? Math.max(1, j.file.size) : j.done), 0) / total : 0;

  const [removed, setRemoved] = useState(false);
  async function removeFromPhone(uris: string[]) {
    // into the phone's own trash, as Free up space does: restorable for 30 days
    const ok = await away(() => N.trashFromLibrary(uris));
    setRemoved(ok);
    setNote(ok ? tn(uris.length, "Moved {n} item to the phone's trash.", "Moved {n} items to the phone's trash.") : t("Kept on this phone."));
  }

  // only the share shown here: one that arrived since (another app shared again) stays for its own screen
  const forgetShare = () => {
    if (from === "picker") return;
    const now = getSharedPayloads().map((p) => p.value ?? "");
    if (now.length && now.every((u) => shared.current.includes(u))) clearSharedPayloads();
  };

  // a share opens on top of whatever was on screen: Done leaves only the library, so Back then leaves the app
  const close = () => {
    signal.current.cancelled = true;
    forgetShare();
    if (router.canDismiss()) router.dismissAll();
    router.replace("/library");
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header style={{ backgroundColor: theme.colors.background }}>
        <Appbar.Action icon="x" accessibilityLabel={finished ? t("Close") : asking ? t("Cancel") : t("Stop and close")} onPress={close} />
        <Appbar.Content title={problem ? t("Couldn't upload") : asking ? t("Upload to Cipherfilm?") : finished ? (failed.length ? t("Some didn't upload") : t("Uploaded")) : t("Uploading")} titleStyle={text.page} />
      </Appbar.Header>
      <View style={st.summary}>
        <Problem>{problem}</Problem>
        {jobs ? (
          <>
            <Text variant="bodyLarge" style={{ marginBottom: 8 }}>
              {asking
                ? shareSummary(all.map((j) => j.file), me?.user.email ?? t("this account"))
                : finished
                ? (failed.length ? t("{done} of {n} uploaded, {failed} failed.", { done: done.length, n: all.length, failed: failed.length }) : t("{done} of {n} uploaded.", { done: done.length, n: all.length }))
                : tn(all.length, "Encrypting and uploading {n} file. Keep the app open.", "Encrypting and uploading {n} files. Keep the app open.")}
            </Text>
            {finished || asking ? null : <ProgressBar progress={progress} color={theme.colors.primary} style={{ height: 5, borderRadius: 3, backgroundColor: theme.colors.outlineVariant }} />}
          </>
        ) : !problem ? (
          <Loading inline label={t("Reading shared files…")} style={st.wait} />
        ) : null}
      </View>
      <FlatList
        data={all}
        keyExtractor={(j) => j.file.uri}
        contentContainerStyle={{ paddingBottom: inset.bottom + 96 }}
        ItemSeparatorComponent={() => <View style={[st.rule, { backgroundColor: theme.colors.outlineVariant }]} />}
        renderItem={({ item: j }) => <Row job={j} asking={asking} />}
      />
      {asking ? (
        <View style={[st.actions, { paddingBottom: inset.bottom + 16, backgroundColor: theme.colors.background, borderTopColor: theme.colors.outlineVariant }]}>
          <Button mode="outlined" onPress={close} style={{ flex: 1 }} contentStyle={{ height: 48 }}>{t("Cancel")}</Button>
          <Button mode="contained" onPress={upload} style={{ flex: 1 }} contentStyle={{ height: 48 }}>{t("Upload")}</Button>
        </View>
      ) : finished ? (
        <View style={[st.actions, { paddingBottom: inset.bottom + 16, backgroundColor: theme.colors.background, borderTopColor: theme.colors.outlineVariant }]}>
          {failed.length && !failed.some((j) => j.stopped) ? <Button mode="outlined" onPress={retry} style={{ flex: 1 }} contentStyle={{ height: 48 }}>{t("Try again")}</Button> : null}
          {!removed && deletable.length ? <Button mode="outlined" onPress={() => removeFromPhone(deletable.map((j) => j.file.uri))} style={{ flex: 1 }} contentStyle={{ height: 48 }}>{t("Remove from phone")}</Button> : null}
          <Button mode="contained" onPress={close} style={{ flex: 1 }} contentStyle={{ height: 48 }}>{t("Done")}</Button>
        </View>
      ) : null}
      <Snackbar visible={!!note} onDismiss={() => setNote(undefined)} duration={4000} style={{ marginBottom: inset.bottom + 80 }}>{note}</Snackbar>
    </View>
  );
}

function Row({ job, asking }: { job: Job; asking: boolean }) {
  const theme = useAppTheme();
  const { file, state } = job;
  const pct = file.size ? Math.round((job.done / file.size) * 100) : 0;
  return (
    <View style={st.row}>
      <View style={[st.thumb, { backgroundColor: theme.colors.surfaceVariant }]}>
        <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="none" recyclingKey={file.uri} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{file.name}</Text>
        <Text variant="bodySmall" style={{ color: state === "error" ? theme.colors.error : theme.colors.onSurfaceVariant }} numberOfLines={2}>
          {state === "error" ? job.error : state === "done" ? t("{size} · encrypted and uploaded", { size: fmtSize(file.size) }) : state === "working" ? t("{pct} % of {size}", { pct: pct.toLocaleString(locale()), size: fmtSize(file.size) }) : asking ? fmtSize(file.size) : t("{size} · waiting", { size: fmtSize(file.size) })}
        </Text>
      </View>
      <View style={st.state}>
        {state === "done" ? <Icon name="check" color={theme.colors.primary} /> : state === "working" ? <Loader /> : state === "error" ? <Icon name="x" color={theme.colors.error} /> : null}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  summary: { paddingHorizontal: 16, paddingBottom: 16 },
  wait: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 64 },
  thumb: { width: 48, height: 48, borderRadius: radius.tile, overflow: "hidden" },
  state: { width: 24, alignItems: "center" },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: 76 },
  actions: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
