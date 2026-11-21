// Account › Memories › Custom reviews › New or Edit: what the review searches for (with how many photos that finds
// now), how often it comes, how many photos it shows, whether a notification says it's ready, and its name.
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Appbar, Button, Divider, Portal, SegmentedButtons, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { COUNTS, EVERY, MAX_TEXT, type Every } from "@memories/custom";
import { useLibrary, refreshLibrary } from "../../libraryStore";
import { editorGate, everyLabel, matchesFor, removeReview, saveReview, useReviews } from "../../reviews";
import { wordsBlocked } from "../../search/engine";
import { isPlayBuild } from "../../store";
import { Dialog, Field, Problem, SwitchItem, useAppTheme } from "../../ui";
import { busyIcon } from "../../Loader";
import { useAction } from "../../useAction";
import { text } from "../../tokens";
import { t, tn } from "../../i18n";

export default function EditReview() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const id = useLocalSearchParams<{ id?: string }>().id || undefined;
  const { shown } = useReviews();
  const { items } = useLibrary();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  // (shown: in the Play build a review this phone hasn't checked isn't opened, not even here)
  const existing = id ? shown?.find((r) => r.id === id) : undefined;

  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [every, setEvery] = useState<Every>("week");
  const [count, setCount] = useState(12);
  const [notify, setNotify] = useState(false);
  // filled once from the review (when editing) as soon as it's there
  const filled = useRef(false);
  useEffect(() => {
    if (filled.current || !existing) return;
    filled.current = true;
    setQuery(existing.query); setName(existing.name === existing.query ? "" : existing.name);
    setEvery(existing.every); setCount(existing.count); setNotify(existing.notify);
  }, [existing]);

  // how many photos the search finds now, and (Play build) whether its words pass: a moment after typing stops
  const play = isPlayBuild();
  const [found, setFound] = useState<number | null>(null);
  const [gate, setGate] = useState<"ok" | "model" | "blocked" | null>(play ? null : "ok");
  useEffect(() => {
    const q = query.trim();
    setFound(null);
    if (play) setGate(null);
    if (!q || !items) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const m = await matchesFor(q, items);
        if (live) setFound(m.length);
        if (play) {
          const g = editorGate(true, await wordsBlocked(q), await wordsBlocked(name.trim() || q));
          if (live) { setGate(g); if (g === "blocked") setFound(0); }
        }
      } catch { if (live) setFound(0); }
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [query, name, items]);

  const save = useAction();
  const del = useAction();
  const [ask, setAsk] = useState(false);
  const canSave = !!query.trim() && gate === "ok" && !save.busy;
  const onSave = () => save.run(async () => {
    await saveReview({ id, name: name.trim() || query.trim(), query, every, count, notify });
    router.back();
  });
  const onDelete = () => del.run(async () => {
    if (id) await removeReview(id);
    setAsk(false);
    router.back();
  });
  const gone = !!id && shown !== null && !existing;

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={id ? t("Edit review") : t("New review")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <View style={st.block}>
          {gone ? <Problem>{t("This review isn't here any more.")}</Problem> : null}
          <Field label={t("Search for")} value={query} onChangeText={setQuery} maxLength={MAX_TEXT} autoFocus={!id} returnKeyType="done"
            placeholder={t("e.g. dog, beach, Anna in Rome")} />
          <Text variant="bodySmall" accessibilityLiveRegion="polite" style={{ color: th.colors.onSurfaceVariant, marginTop: -4, marginBottom: 8, paddingHorizontal: 4 }}>
            {!query.trim() ? t("Words, people, places and dates work as in Search.")
              : gate === "model" ? t("Custom reviews need search set up on this phone.")
              : found === null ? t("Searching…")
              : found === 0 ? t("No photos match")
              : tn(found, "{n} photo matches", "{n} photos match")}
          </Text>
        </View>
        <Divider />
        <View style={st.block}>
          <Text variant="titleSmall" style={st.label}>{t("How often")}</Text>
          <SegmentedButtons value={every} onValueChange={(v) => setEvery(v as Every)}
            buttons={EVERY.map((e) => ({ value: e, label: everyLabel(e) }))} />
          <Text variant="titleSmall" style={[st.label, { marginTop: 20 }]}>{t("Photos")}</Text>
          <SegmentedButtons value={String(count)} onValueChange={(v) => setCount(Number(v))}
            buttons={COUNTS.map((c) => ({ value: String(c), label: String(c), accessibilityLabel: tn(c, "{n} photo", "{n} photos") }))} />
        </View>
        <Divider />
        <SwitchItem title={t("Notify me")} description={t("A notification when it's ready, without saying what it shows.")}
          value={notify} onValueChange={setNotify} style={st.item} />
        <Divider />
        <View style={st.block}>
          <Field label={t("Name")} value={name} onChangeText={setName} maxLength={MAX_TEXT} placeholder={query.trim() || undefined}
            hint={t("Leave empty to use what it searches for.")} />
          <Problem>{save.error}</Problem>
          <Button mode="contained" onPress={onSave} disabled={!canSave || gone} icon={save.busy ? busyIcon : undefined} contentStyle={{ height: 48 }}>{t("Save")}</Button>
          {id && !gone ? (
            <Button mode="outlined" textColor={th.colors.error} onPress={() => setAsk(true)} style={{ marginTop: 12 }} contentStyle={{ height: 48 }}>{t("Delete review")}</Button>
          ) : null}
        </View>
      </ScrollView>
      <Portal>
        <Dialog visible={ask} onDismiss={() => { if (!del.busy) setAsk(false); }}>
          <Dialog.Title>{t("Delete this review?")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("It goes from all your devices. Your photos stay.")}</Text>
            <Problem>{del.error}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsk(false)} disabled={del.busy}>{t("Cancel")}</Button>
            <Button textColor={th.colors.error} onPress={onDelete} icon={del.busy ? busyIcon : undefined} disabled={del.busy}>{t("Delete")}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const st = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingVertical: 16 },
  label: { marginBottom: 8 },
  item: { minHeight: 64, paddingHorizontal: 8 },
});
