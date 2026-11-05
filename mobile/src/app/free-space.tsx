import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { ActivityIndicator, Appbar, Button, Dialog, Divider, List, Portal, RadioButton, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N, { type PhoneMedia } from "../../modules/cf-native/src/CfNativeModule";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { fingerprint } from "../prints";
import { Icon } from "../icons";
import { Problem, useAppTheme } from "../ui";
import { radius, text } from "../tokens";
import { useMediaDisclosure } from "../disclosure";

const DAY = 86400_000;
const AGES = [{ key: "0", label: "All of them", days: 0 }, { key: "30", label: "Older than 30 days", days: 30 }, { key: "90", label: "Older than 3 months", days: 90 }, { key: "365", label: "Older than a year", days: 365 }];
const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(n > 0 ? 1 : 0, Math.round(n / 1e6))} MB`);

/** Free up space: photos and videos on this phone that are already safely in Cipherfilm (same name and size, upload
 *  finished, not in the trash) go to the phone's own trash, after Android's own confirmation. */
export default function FreeSpace() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const { items, error: libraryError, loadedAt } = useLibrary();
  // decided on the server's list as it is now, never a cached or older one (trashed elsewhere meanwhile)
  const [opened] = useState(Date.now);
  const fresh = loadedAt >= opened && !libraryError;
  const [media, setMedia] = useState<PhoneMedia[] | null>(null);
  const [access, setAccess] = useState(() => N.backupState().media);
  const [age, setAge] = useState("0");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [matched, setMatched] = useState<PhoneMedia[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ n: number; bytes: number } | null>(null);
  const [error, setError] = useState<string>();
  const disclosure = useMediaDisclosure();
  // Android's own trash (with its confirmation) exists from Android 11; before that, nothing is removed from here
  const [canTrash] = useState(() => N.backupState().sdk >= 30);

  const scan = useCallback(async () => {
    const st = N.backupState();
    setAccess(st.media);
    if (st.media === "none") return;
    setMatched(null);
    try { setMedia(await N.phoneMedia()); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    scan();
    refreshLibrary();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") scan(); });
    return () => sub.remove();
  }, [scan]);

  // what is safely in the library: same name and size as a finished, verified item
  useEffect(() => {
    if (!media || !items || !fresh) return;
    let live = true;
    (async () => {
      const prints = new Set<string>();
      for (const it of items) if (it.meta && !it.broken && it.meta.size > 0) prints.add(await fingerprint(it.meta.name, it.meta.size));
      const out: PhoneMedia[] = [];
      for (const m of media) if (m.size > 0 && prints.has(await fingerprint(m.name, m.size))) out.push(m);
      if (live) setMatched(out);
    })();
    return () => { live = false; };
  }, [media, items, fresh]);

  const days = AGES.find((a) => a.key === age)!.days;
  const folders = useMemo(() => {
    const byFolder = new Map<string, { name: string; n: number; bytes: number }>();
    for (const m of matched ?? []) {
      const f = byFolder.get(m.bucket) ?? byFolder.set(m.bucket, { name: m.folder || "Other", n: 0, bytes: 0 }).get(m.bucket)!;
      f.n++; f.bytes += m.size;
    }
    return [...byFolder.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  }, [matched]);
  const chosen = useMemo(() => (matched ?? []).filter((m) => !skip.has(m.bucket) && (!days || m.taken < Date.now() - days * DAY)), [matched, skip, days]);
  const bytes = chosen.reduce((n, m) => n + m.size, 0);
  const total = (media ?? []).reduce((n, m) => n + m.size, 0);

  // the disclosure first, then Android's prompt
  const askMedia = async () => {
    await disclosure.ask("freeSpace");
    scan();
  };

  const free = async () => {
    setAsking(false); setBusy(true); setError(undefined);
    try {
      let n = 0, b = 0;
      // Android shows one confirmation per request; large selections go in a few
      for (let i = 0; i < chosen.length; i += 2000) {
        const part = chosen.slice(i, i + 2000);
        if (!(await N.trashFromLibrary(part.map((m) => m.uri)))) break;
        n += part.length; b += part.reduce((x, m) => x + m.size, 0);
      }
      if (n) setDone({ n, bytes: b });
      await scan();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <Appbar.Header style={{ backgroundColor: t.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
        <Appbar.Content title="Free up space" titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 32 }}>
        {access === "none" ? (
          <View style={[st.card, { backgroundColor: t.colors.surfaceVariant }]}>
            <Text variant="bodyMedium">To find photos on this phone that are already in Cipherfilm, allow access to photos and videos.</Text>
            <Button mode="contained" onPress={askMedia} style={st.button}>Allow</Button>
          </View>
        ) : !matched && libraryError ? (
          <View style={{ padding: 16 }}><Problem>{`Your library couldn't be loaded, so nothing is offered for removal. ${libraryError}`}</Problem></View>
        ) : !matched ? (
          <View style={{ alignItems: "center", padding: 32 }}><ActivityIndicator /><Text variant="bodyMedium" style={{ marginTop: 12 }}>Comparing this phone with your library…</Text></View>
        ) : (
          <>
            <View style={[st.card, { backgroundColor: chosen.length ? t.colors.primaryContainer : t.colors.surfaceVariant }]}>
              <View style={st.row}>
                <Icon name="phone" size={28} color={t.colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text variant="headlineSmall">{chosen.length ? gb(bytes) : "Nothing to free"}</Text>
                  <Text variant="bodyMedium" style={{ color: t.colors.onSurfaceVariant }}>
                    {chosen.length ? `${chosen.length} ${chosen.length === 1 ? "photo or video is" : "photos and videos are"} already safe in Cipherfilm` : matched.length ? "None match the choice below." : `None of the ${(media ?? []).length} photos and videos on this phone (${gb(total)}) are in your library yet.`}
                  </Text>
                </View>
              </View>
              {access === "partial" ? (
                <>
                  <Text variant="bodySmall" style={{ marginTop: 8 }}>Cipherfilm sees only the photos you chose. Allow more to find the rest.</Text>
                  <Button mode="outlined" compact onPress={askMedia} style={{ marginTop: 8, alignSelf: "flex-start" }}>Choose photos</Button>
                </>
              ) : null}
              {!canTrash ? <Text variant="bodySmall" style={{ marginTop: 8 }}>Removing photos from here needs Android 11 or newer. Delete them in your gallery app instead.</Text> : null}
              <Button mode="contained" icon="trash" disabled={!chosen.length || busy || !canTrash} loading={busy} onPress={() => setAsking(true)} style={st.button}>Remove from this phone</Button>
            </View>
            {done ? <Text variant="bodyMedium" style={st.hint}>Moved {done.n} ({gb(done.bytes)}) to the phone's trash. Android removes them for good after 30 days; until then you can restore them in your gallery app.</Text> : null}
            <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>

            <List.Subheader>Which ones</List.Subheader>
            <RadioButton.Group value={age} onValueChange={setAge}>
              {AGES.map((a) => <RadioButton.Item key={a.key} label={a.label} value={a.key} labelVariant="bodyLarge" />)}
            </RadioButton.Group>
            {folders.length > 1 || skip.size ? (
              <>
                <Divider style={{ marginTop: 8 }} />
                <List.Subheader>Folders</List.Subheader>
                {folders.map(([id, f]) => (
                  <List.Item key={id} title={f.name} description={`${f.n} · ${gb(f.bytes)}`} accessibilityRole="checkbox" accessibilityState={{ checked: !skip.has(id) }}
                    onPress={() => setSkip((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })}
                    left={() => <View style={{ justifyContent: "center", paddingLeft: 16, paddingRight: 4 }}><Icon name={skip.has(id) ? "boxOff" : "boxOn"} size={24} color={skip.has(id) ? t.colors.onSurfaceVariant : t.colors.primary} /></View>} />
                ))}
              </>
            ) : null}
            <Divider style={{ marginTop: 8 }} />
            <Text variant="bodySmall" style={[st.hint, { color: t.colors.onSurfaceVariant, marginTop: 12 }]}>
              Only photos and videos with the same name and size as one in your library are offered, and only after their upload finished. They stay in Cipherfilm, encrypted. Android asks you to confirm, then keeps them in its trash for 30 days.
            </Text>
          </>
        )}
      </ScrollView>
      {disclosure.dialog}
      <Portal>
        <Dialog visible={asking} onDismiss={() => setAsking(false)}>
          <Dialog.Title>Remove {chosen.length} from this phone?</Dialog.Title>
          <Dialog.Content><Text variant="bodyMedium">They stay in Cipherfilm. Android moves them to its trash and asks you to confirm.</Text></Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsking(false)}>Cancel</Button>
            <Button onPress={free}>Remove {gb(bytes)}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const st = StyleSheet.create({
  card: { margin: 16, padding: 16, borderRadius: radius.card },
  row: { flexDirection: "row", alignItems: "center", gap: 16 },
  button: { marginTop: 16, alignSelf: "flex-start" },
  hint: { paddingHorizontal: 16, paddingVertical: 4 },
});
