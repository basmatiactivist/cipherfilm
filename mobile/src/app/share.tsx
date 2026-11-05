import { useEffect, useRef, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { clearSharedPayloads, getSharedPayloads } from "expo-sharing";
import { useKeepAwake } from "expo-keep-awake";
import { ActivityIndicator, Appbar, Button, ProgressBar, Snackbar, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N from "../../modules/cf-native/src/CfNativeModule";
import { describe, SignedOut, uploadShared, type Shared } from "../upload";
import { useSession } from "../session";
import { refreshLibrary } from "../libraryStore";
import { takePicked } from "../pending";
import { Problem, useAppTheme } from "../ui";
import { Icon } from "../icons";
import { radius, text } from "../tokens";

interface Job { file: Shared; state: "queued" | "working" | "done" | "error"; done: number; error?: string }
const FILES_AT_ONCE = 2;
const fmtSize = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Photos shared from another app: encrypted and uploaded here, then (if the person wants) removed from the phone. */
export default function ShareScreen() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const { phase } = useSession();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [problem, setProblem] = useState<string>();
  const [note, setNote] = useState<string>();
  const [finished, setFinished] = useState(false);
  const started = useRef(false);
  const signal = useRef({ cancelled: false });

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
    }
    if (!sources.length) { if (from === "picker") router.back(); return; }
    started.current = true;
    (async () => {
      try {
        const files = await Promise.all(sources.map((x) => describe(x.uri, x.hint)));
        const list: Job[] = files.map((file) => ({ file, state: "queued", done: 0 }));
        setJobs(list);
        await run(list);
      } catch (e) {
        // usually the other app didn't pass on the permission to read the file (or the file is gone)
        console.log("share: couldn't read", e);
        setProblem("Cipherfilm couldn't read what was shared. Share it again from the other app, or use Upload in Photos.");
        setFinished(true);
      }
    })();
  }, [phase, from]);

  const patch = (uri: string, p: Partial<Job>) => setJobs((js) => js && js.map((j) => (j.file.uri === uri ? { ...j, ...p } : j)));

  async function run(list: Job[]) {
    const queue = [...list];
    const results = new Map<string, boolean>();
    const worker = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        patch(j.file.uri, { state: "working" });
        try {
          await uploadShared(j.file, (done) => patch(j!.file.uri, { done }), signal.current);
          patch(j.file.uri, { state: "done", done: j.file.size });
          results.set(j.file.uri, true);
        } catch (e) {
          patch(j.file.uri, { state: "error", error: e instanceof Error ? e.message : "Upload failed." });
          results.set(j.file.uri, false);
          if (e instanceof SignedOut) return;
        }
      }
    };
    await Promise.all(Array.from({ length: FILES_AT_ONCE }, worker));
    refreshLibrary();
    setFinished(true);
    // straight to Android's own confirmation (one for all, with previews): only files that are safely on the server,
    // and that Android lets us remove; failed ones always stay
    const removable = list.filter((j) => results.get(j.file.uri) && j.file.deletable).map((j) => j.file.uri);
    if (removable.length) await removeFromPhone(removable);
  }

  const retry = async () => {
    const failed = (jobs ?? []).filter((j) => j.state === "error").map((j) => ({ ...j, state: "queued" as const, done: 0, error: undefined }));
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
    const ok = await N.deleteFromLibrary(uris);
    setRemoved(ok);
    setNote(ok ? `Removed ${uris.length === 1 ? "1 item" : `${uris.length} items`} from this phone.` : "Kept on this phone.");
  }


  // a share opens on top of whatever was on screen: Done leaves only the library, so Back then leaves the app
  const close = () => {
    signal.current.cancelled = true;
    if (from !== "picker") clearSharedPayloads();
    if (router.canDismiss()) router.dismissAll();
    router.replace("/library");
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <Appbar.Header style={{ backgroundColor: t.colors.background }}>
        <Appbar.Action icon="x" accessibilityLabel={finished ? "Close" : "Stop and close"} onPress={close} />
        <Appbar.Content title={problem ? "Couldn't upload" : finished ? (failed.length ? "Some didn't upload" : "Uploaded") : "Uploading"} titleStyle={text.page} />
      </Appbar.Header>
      <View style={st.summary}>
        <Problem>{problem}</Problem>
        {jobs ? (
          <>
            <Text variant="bodyLarge" style={{ marginBottom: 8 }}>
              {finished
                ? `${done.length} of ${all.length} safely in Cipherfilm${failed.length ? `, ${failed.length} failed` : ""}.`
                : `Encrypting and uploading ${all.length === 1 ? "1 file" : `${all.length} files`}. Keep the app open.`}
            </Text>
            {finished ? null : <ProgressBar progress={progress} color={t.colors.primary} style={{ height: 5, borderRadius: 3, backgroundColor: t.colors.outlineVariant }} />}
          </>
        ) : !problem ? (
          <View style={st.wait}><ActivityIndicator /><Text variant="bodyMedium" style={{ marginLeft: 12 }}>Reading what you shared</Text></View>
        ) : null}
      </View>
      <FlatList
        data={all}
        keyExtractor={(j) => j.file.uri}
        contentContainerStyle={{ paddingBottom: inset.bottom + 96 }}
        ItemSeparatorComponent={() => <View style={[st.rule, { backgroundColor: t.colors.outlineVariant }]} />}
        renderItem={({ item: j }) => <Row job={j} />}
      />
      {finished ? (
        <View style={[st.actions, { paddingBottom: inset.bottom + 16, backgroundColor: t.colors.background, borderTopColor: t.colors.outlineVariant }]}>
          {failed.length && !failed.some((j) => j.error?.startsWith("Stopped")) ? <Button mode="outlined" onPress={retry} style={{ flex: 1 }} contentStyle={{ height: 48 }}>Try again</Button> : null}
          {!removed && deletable.length ? <Button mode="outlined" onPress={() => removeFromPhone(deletable.map((j) => j.file.uri))} style={{ flex: 1 }} contentStyle={{ height: 48 }}>Remove from phone</Button> : null}
          <Button mode="contained" onPress={close} style={{ flex: 1 }} contentStyle={{ height: 48 }}>Done</Button>
        </View>
      ) : null}
      <Snackbar visible={!!note} onDismiss={() => setNote(undefined)} duration={4000} style={{ marginBottom: inset.bottom + 80 }}>{note}</Snackbar>
    </View>
  );
}

function Row({ job }: { job: Job }) {
  const t = useAppTheme();
  const { file, state } = job;
  const pct = file.size ? Math.round((job.done / file.size) * 100) : 0;
  return (
    <View style={st.row}>
      <View style={[st.thumb, { backgroundColor: t.colors.surfaceVariant }]}>
        <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="none" recyclingKey={file.uri} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{file.name}</Text>
        <Text variant="bodySmall" style={{ color: state === "error" ? t.colors.error : t.colors.onSurfaceVariant }} numberOfLines={2}>
          {state === "error" ? job.error : state === "done" ? `${fmtSize(file.size)} · encrypted and uploaded` : state === "working" ? `${pct} % of ${fmtSize(file.size)}` : `${fmtSize(file.size)} · waiting`}
        </Text>
      </View>
      <View style={st.state}>
        {state === "done" ? <Icon name="check" color={t.colors.primary} /> : state === "working" ? <ActivityIndicator size={18} /> : state === "error" ? <Icon name="x" color={t.colors.error} /> : null}
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
