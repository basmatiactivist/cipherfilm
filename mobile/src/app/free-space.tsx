import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, Divider, List, Portal, RadioButton, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N, { type PhoneMedia } from "../../modules/cf-native/src/CfNativeModule";
import { away } from "../autolock";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { fingerprint } from "../prints";
import { Icon } from "../icons";
import { Problem, useAppTheme } from "../ui";
import { radius, text } from "../tokens";
import { useMediaDisclosure } from "../disclosure";
import { busyIcon, Loading } from "../Loader";
import { locale, t, tn } from "../i18n";

const DAY = 86400_000;
const AGES = [{ key: "0", label: () => t("All of them"), days: 0 }, { key: "30", label: () => t("Older than 30 days"), days: 30 }, { key: "90", label: () => t("Older than 3 months"), days: 90 }, { key: "365", label: () => t("Older than a year"), days: 365 }];
const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB` : `${Math.max(n > 0 ? 1 : 0, Math.round(n / 1e6)).toLocaleString(locale())} MB`);

/** Free up space: photos and videos on this phone that are already safely in Cipherfilm (same name and size, upload
 *  finished, not in the trash) go to the phone's own trash, after Android's own confirmation. */
export default function FreeSpace() {
  const theme = useAppTheme();
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
      const f = byFolder.get(m.bucket) ?? byFolder.set(m.bucket, { name: m.folder || t("Other"), n: 0, bytes: 0 }).get(m.bucket)!;
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
        if (!(await away(() => N.trashFromLibrary(part.map((m) => m.uri))))) break;
        n += part.length; b += part.reduce((x, m) => x + m.size, 0);
      }
      if (n) setDone({ n, bytes: b });
      await scan();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("That didn't work."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header style={{ backgroundColor: theme.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Free up space")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 32 }}>
        {access === "none" ? (
          <View style={[st.card, { backgroundColor: theme.colors.surfaceVariant }]}>
            <Text variant="bodyMedium">{t("Allow access to photos and videos to find the ones already in Cipherfilm.")}</Text>
            <Button mode="contained" onPress={askMedia} style={st.button}>{t("Allow")}</Button>
          </View>
        ) : !matched && libraryError ? (
          <View style={{ padding: 16 }}><Problem>{t("Couldn't load your library, so nothing can be removed. {error}", { error: libraryError })}</Problem></View>
        ) : !matched ? (
          <Loading label={t("Comparing this phone with your library…")} />
        ) : (
          <>
            <View style={[st.card, { backgroundColor: chosen.length ? theme.colors.primaryContainer : theme.colors.surfaceVariant }]}>
              <View style={st.row}>
                <Icon name="phone" size={28} color={theme.colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text variant="headlineSmall">{chosen.length ? gb(bytes) : t("Nothing to free")}</Text>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                    {chosen.length ? tn(chosen.length, "{n} photo or video is already in Cipherfilm", "{n} photos and videos are already in Cipherfilm") : matched.length ? t("None match the choice below.") : tn((media ?? []).length, "The {n} photo or video on this phone ({size}) isn't in Cipherfilm yet.", "None of the {n} photos and videos on this phone ({size}) are in Cipherfilm yet.", { size: gb(total) })}
                  </Text>
                </View>
              </View>
              {access === "partial" ? (
                <>
                  <Text variant="bodySmall" style={{ marginTop: 8 }}>{t("Cipherfilm only sees the photos you chose.")}</Text>
                  <Button mode="outlined" compact onPress={askMedia} style={{ marginTop: 8, alignSelf: "flex-start" }}>{t("Choose photos")}</Button>
                </>
              ) : null}
              {!canTrash ? <Text variant="bodySmall" style={{ marginTop: 8 }}>{t("Removing needs Android 11 or newer. Delete them in your gallery app instead.")}</Text> : null}
              <Button mode="contained" icon={busy ? busyIcon : "trash"} disabled={!chosen.length || busy || !canTrash} onPress={() => setAsking(true)} style={st.button}>{t("Remove from this phone")}</Button>
            </View>
            {done ? <Text variant="bodyMedium" style={st.hint}>{tn(done.n, "Moved {n} ({size}) to the phone's trash. You can restore it in your gallery app for 30 days.", "Moved {n} ({size}) to the phone's trash. You can restore them in your gallery app for 30 days.", { size: gb(done.bytes) })}</Text> : null}
            <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>

            <List.Subheader>{t("Which ones")}</List.Subheader>
            <RadioButton.Group value={age} onValueChange={setAge}>
              {AGES.map((a) => <RadioButton.Item key={a.key} label={a.label()} value={a.key} labelVariant="bodyLarge" />)}
            </RadioButton.Group>
            {folders.length > 1 || skip.size ? (
              <>
                <Divider style={{ marginTop: 8 }} />
                <List.Subheader>{t("Folders")}</List.Subheader>
                {folders.map(([id, f]) => (
                  <List.Item key={id} title={f.name} description={`${f.n.toLocaleString(locale())} · ${gb(f.bytes)}`} accessibilityRole="checkbox" accessibilityState={{ checked: !skip.has(id) }}
                    onPress={() => setSkip((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })}
                    left={() => <View style={{ justifyContent: "center", paddingLeft: 16, paddingRight: 4 }}><Icon name={skip.has(id) ? "boxOff" : "boxOn"} size={24} color={skip.has(id) ? theme.colors.onSurfaceVariant : theme.colors.primary} /></View>} />
                ))}
              </>
            ) : null}
            <Divider style={{ marginTop: 8 }} />
            <Text variant="bodySmall" style={[st.hint, { color: theme.colors.onSurfaceVariant, marginTop: 12 }]}>
              {t("Only photos and videos fully uploaded to your library (same name and size) are offered. They stay in Cipherfilm. Android asks you to confirm, then keeps them in its trash for 30 days.")}
            </Text>
          </>
        )}
      </ScrollView>
      {disclosure.dialog}
      <Portal>
        <Dialog visible={asking} onDismiss={() => setAsking(false)}>
          <Dialog.Title>{t("Remove {n} from this phone?", { n: chosen.length.toLocaleString(locale()) })}</Dialog.Title>
          <Dialog.Content><Text variant="bodyMedium">{t("They stay in Cipherfilm. Android asks you to confirm, then moves them to the phone's trash.")}</Text></Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsking(false)}>{t("Cancel")}</Button>
            <Button onPress={free}>{t("Remove {size}", { size: gb(bytes) })}</Button>
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
