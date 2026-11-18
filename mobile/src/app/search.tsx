import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button, Chip, ProgressBar, Searchbar, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gallery } from "../Gallery";
import { NAV_HEIGHT, NavBar } from "../NavBar";
import { FaceAvatar } from "../Faces";
import { Icon, type IconName } from "../icons";
import { refreshLibrary, useLibrary } from "../libraryStore";
import type { Item } from "../library";
import { similarTo, useSearchProgress, useTextProgress, type Progress } from "../search/engine";
import { usePeople } from "../search/people";
import { EMPTY, removeChip, search, SUGGESTIONS, type Result } from "../search/query";
import { loadSettings, onSettingsChange, type SearchSettings } from "../search/settings";
import { useAppTheme } from "../ui";
import { radius, text } from "../tokens";
import { Loader } from "../Loader";
import { SearchTips } from "../SearchTips";
import { locale, t, tn } from "../i18n";

const mb = (n: number) => `${Math.round(n / 1e6).toLocaleString(locale())} MB`;
const num = (n: number) => n.toLocaleString(locale());

/** Search: one box for people, things, places in time, file names; below it people, shortcuts and ideas. */
export default function Search() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const params = useLocalSearchParams<{ similar?: string; q?: string }>();
  const { items, error } = useLibrary();
  const [tips, setTips] = useState(false);
  const [q, setQ] = useState(params.q ?? "");
  const [res, setRes] = useState<Result | null>(null);
  const [similar, setSimilar] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** whether the photos ranked below the close matches show ("More similar photos"); closed again for a new search */
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setMoreOpen(false), [q]);
  const progress = useSearchProgress();
  const settings = useSettings();
  const { groups } = usePeople();
  const seq = useRef(0);
  useEffect(() => { if (!items) refreshLibrary(); }, []);

  // photos like one from the viewer; an answer that comes after Close or typing is dropped
  useEffect(() => {
    if (!params.similar || !items) return;
    let live = true;
    const byId = new Map(items.map((i) => [i.id, i]));
    const self = byId.get(params.similar);
    similarTo(params.similar).then((hits) => live && setSimilar([...(self ? [self] : []), ...hits.map((h) => byId.get(h.id)).filter((i): i is Item => !!i)]), () => live && setSimilar([]));
    return () => { live = false; };
  }, [params.similar, items, progress.phase]);

  useEffect(() => {
    const mine = ++seq.current;
    if (!q.trim()) { setRes(null); setBusy(false); return; }
    setBusy(true);
    const h = setTimeout(() => {
      // one that fails finds nothing, rather than leaving the badge on
      search(q, (items ?? []).filter((i) => !i.broken)).then((r) => { if (seq.current === mine) setRes(r); }, () => { if (seq.current === mine) setRes(EMPTY); })
        .finally(() => { if (seq.current === mine) setBusy(false); });
    }, 250);
    return () => clearTimeout(h);
  }, [q, items, progress.phase === "ready"]);

  const people = useMemo(() => (groups ?? []).filter((g) => !g.person?.hidden).sort((a, b) => Number(!!b.person?.name) - Number(!!a.person?.name) || b.items.length - a.items.length), [groups]);

  // the image model ranked photos, but none closely (search/query.ts): they show at once, under "No close matches"
  const noClose = !similar && !!res && !res.items.length && res.similar.length > 0;
  const moreSimilar = !similar && !noClose && res ? res.similar.length : 0;

  const bar = (
    <View style={{ paddingTop: inset.top + 8, paddingHorizontal: 16 + inset.left, paddingBottom: 8 }}>
      <Searchbar placeholder={t("Search your photos")} value={q} onChangeText={(v) => { setQ(v); setSimilar(null); if (params.similar) router.setParams({ similar: "" }); }}
        right={busy ? ({ style }) => <View style={[style, { marginRight: 16 }]}><Loader /></View> : undefined}
        icon="search" clearIcon="x" style={{ backgroundColor: th.colors.surfaceVariant }} inputStyle={{ minHeight: 0 }}
        autoCorrect={false} returnKeyType="search" accessibilityLabel={t("Search your photos")}
        searchAccessibilityLabel={t("Search")} clearAccessibilityLabel={t("Clear the search")} />
      {/* what the words were taken as (a person, a place, dates…): all of them hold; × takes those words out of the box */}
      {q.trim() && res?.chips.length ? (
        <View style={st.queryChips}>
          {res.chips.map((c) => (
            <Chip key={`${c.kind}:${c.start}`} compact onClose={() => setQ(removeChip(q, c))} closeIcon="x" closeIconAccessibilityLabel={t("Remove {name}", { name: c.label })} style={{ backgroundColor: th.colors.secondaryContainer }}
              accessibilityLabel={c.label} accessibilityHint={t("Removes this filter")}>{c.label}</Chip>
          ))}
        </View>
      ) : null}
      {/* nothing is a close match (docs/SEARCH.md "Close matches"): said, and the most similar photos show at once */}
      {q.trim() && noClose ? <Text variant="bodySmall" style={{ marginTop: 8, color: th.colors.onSurfaceVariant }}>{t("No close matches. These are the most similar photos.")}</Text>
        : q.trim() && res?.how.length ? <Text variant="bodySmall" numberOfLines={2} style={{ marginTop: 8, color: th.colors.onSurfaceVariant }}>{tn(res.items.length, "{n} result · {how}", "{n} results · {how}", { how: res.how.join(" · ") })}</Text>
        : q.trim() && res?.chips.length ? <Text variant="bodySmall" style={{ marginTop: 8, color: th.colors.onSurfaceVariant }}>{tn(res.items.length, "{n} result", "{n} results")}</Text> : null}
      {similar ? (
        <View style={st.similarRow}>
          <Text style={[text.heading, { flex: 1 }]}>{t("Photos like this one")}</Text>
          <Button compact onPress={() => { setSimilar(null); router.setParams({ similar: "" }); }}>{t("Close")}</Button>
        </View>
      ) : null}
    </View>
  );

  // the search box stays mounted while results replace the ideas below it, so typing keeps its focus
  const findingSimilar = !!params.similar && !q.trim();
  if (q.trim() || similar || findingSimilar) {
    const found = similar ?? (findingSimilar || !res ? null : noClose ? res.similar : moreOpen ? [...res.items, ...res.similar] : res.items);
    // the badge (null) until there is an answer for this search: the library first (without it nothing would be found),
    // then the search; while the next answer runs the last results stay (the box shows the small badge), but an empty
    // one isn't shown as "Nothing found" before the search is done
    const shown = !items ? null : busy && !similar && !found?.length ? null : found;
    return (
      <View style={{ flex: 1, backgroundColor: th.colors.background }}>
        {bar}
        <Gallery items={shown} error={items ? undefined : error} loading={false} onRefresh={() => {}} flat within="search" bottom={NAV_HEIGHT}
          header={res?.people.length && !similar ? (
            <FlatList horizontal data={res.people} keyExtractor={(g) => g.key} contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }} style={{ flexGrow: 0, marginBottom: 4 }}
              renderItem={({ item: g }) => <FaceAvatar group={g} size={56} onPress={() => router.push({ pathname: "/person/[key]", params: { key: g.key } })} />} />
          ) : null}
          split={moreSimilar && moreOpen ? { at: res!.items.length, heading: <SimilarHeading onHide={() => setMoreOpen(false)} /> } : undefined}
          footer={moreSimilar && !moreOpen ? <View style={st.moreSimilar}><Button mode="outlined" onPress={() => setMoreOpen(true)}>{t("More similar photos ({n})", { n: num(moreSimilar) })}</Button></View> : null}
          empty={<NoResults ready={progress.phase === "ready" || progress.phase === "indexing"} on={!!settings?.enabled} onTips={() => setTips(true)} />}
          nav={<NavBar current="search" />} />
        <SearchTips visible={tips} onClose={() => setTips(false)} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      {bar}
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + NAV_HEIGHT + 24 }} keyboardShouldPersistTaps="handled">
        {settings && !settings.enabled ? <TurnOn /> : <Status p={progress} />}
        {settings?.enabled && progress.phase === "ready" ? <TextStatus /> : null}
        {settings?.enabled && settings.faces && people.length ? (
          <>
            <Heading title={t("People")} action={[t("See all"), () => router.push("/people")]} />
            <FlatList horizontal data={people.slice(0, 20)} keyExtractor={(g) => g.key} contentContainerStyle={{ paddingHorizontal: 8, gap: 4 }} showsHorizontalScrollIndicator={false}
              renderItem={({ item: g }) => <FaceAvatar group={g} onPress={() => router.push({ pathname: "/person/[key]", params: { key: g.key } })} />} />
          </>
        ) : null}
        <Heading title={t("Your photos")} />
        <View style={st.chips}>
          <Shortcut icon="heart" label={t("Favorites")} onPress={() => router.push("/favorites")} />
          <Shortcut icon="archive" label={t("Archive")} onPress={() => router.push("/archive")} />
          <Shortcut icon="lock" label={t("Locked folder")} onPress={() => router.push("/locked")} />
          <Shortcut icon="video" label={t("Videos")} onPress={() => setQ("videos")} />
          <Shortcut icon="phone" label={t("Screenshots")} onPress={() => setQ("screenshots")} />
          <Shortcut icon="photos" label={String(new Date().getFullYear() - 1)} onPress={() => setQ(String(new Date().getFullYear() - 1))} />
        </View>
        {settings?.enabled ? (
          <>
            <Heading title={t("Try")} />
            <View style={st.chips}>
              {SUGGESTIONS.map((s) => <Chip key={s} onPress={() => setQ(s)} style={{ backgroundColor: th.colors.surfaceVariant }} compact>{s}</Chip>)}
            </View>
            <Text variant="bodySmall" style={[st.hint, { color: th.colors.onSurfaceVariant }]}>
              {t("Search in English for what's in a photo, or by names, dates (\"july 2023\"), file names and cameras.")}
            </Text>
          </>
        ) : null}
        <Button mode="text" icon="help" onPress={() => setTips(true)} style={st.tipsButton} accessibilityHint={t("Explains what you can search for")}>{t("How search works")}</Button>
      </ScrollView>
      <SearchTips visible={tips} onClose={() => setTips(false)} />
      <NavBar current="search" />
    </View>
  );
}

function useSettings() {
  const [s, setS] = useState<SearchSettings | null>(null);
  useEffect(() => { loadSettings().then(setS); return onSettingsChange(() => loadSettings().then(setS)); }, []);
  return s;
}

function TurnOn() {
  const th = useAppTheme();
  return (
    <View style={[st.card, { backgroundColor: th.colors.primaryContainer }]}>
      <Text style={[text.heading, { marginBottom: 4 }]}>{t("Search what's in your photos")}</Text>
      <Text variant="bodyMedium" style={{ color: th.colors.onPrimaryContainer }}>
        {t("Find \"beach\", \"birthday cake\" or the people in your photos. It runs on this phone; the server never sees what your photos show.")}
      </Text>
      <Button mode="contained" style={{ marginTop: 12, alignSelf: "flex-start" }} onPress={() => router.push("/search-settings")}>{t("Set up search")}</Button>
    </View>
  );
}

function Status({ p }: { p: Progress }) {
  const th = useAppTheme();
  if (p.phase === "ready" || p.phase === "off") return null;
  const text = p.phase === "download" ? t("Downloading the search models · {done} of {total}", { done: mb(p.done), total: mb(p.total) })
    : p.phase === "consent" ? t("Search waits for your OK to download the models ({size}). Tap to see what is downloaded.", { size: mb(p.total) })
    : p.phase === "waitWifi" ? (p.total ? t("Waiting for Wi-Fi to download the search models ({size}).", { size: mb(p.total) }) : t("Waiting for Wi-Fi to download the search models."))
    : p.phase === "loading" ? (p.total ? t("Getting search ready · {done} of {total}", { done: num(p.done), total: num(p.total) }) : p.message ? `${p.message}…` : t("Getting search ready…"))
    : p.phase === "indexing" ? t("Indexing for search · {done} of {total}", { done: num(p.done), total: num(p.total) })
    : t("Search stopped: {message}", { message: p.message ?? t("something went wrong") });
  return (
    <Pressable onPress={() => router.push("/search-settings")} style={[st.card, { backgroundColor: th.colors.surfaceVariant }]} accessibilityRole="button">
      <Text variant="bodyMedium">{text}</Text>
      {p.phase === "download" || p.phase === "indexing" || p.phase === "loading" ? (
        <ProgressBar progress={p.total ? p.done / p.total : 0} indeterminate={p.phase === "loading" && !p.total} color={th.colors.primary} style={{ height: 5, borderRadius: 3, marginTop: 10, backgroundColor: th.colors.outlineVariant }} />
      ) : null}
      {p.phase === "indexing" ? <Text variant="bodySmall" style={{ marginTop: 8, color: th.colors.onSurfaceVariant }}>{t("Results improve as it goes.")}</Text> : null}
    </Pressable>
  );
}

/** Text in photos, when it waits for something or reads older photos (search itself is ready). */
function TextStatus() {
  const th = useAppTheme();
  const p = useTextProgress();
  const text = p.phase === "consent" ? t("Text in photos waits for your OK to download its model ({size}).", { size: mb(p.total) })
    : p.phase === "waitWifi" ? t("Text in photos: waiting for Wi-Fi to download its model ({size}).", { size: mb(p.total) })
    : p.phase === "download" ? t("Text in photos: downloading · {done} of {total}", { done: mb(p.done), total: mb(p.total) })
    : p.phase === "reading" ? t("Reading the text in older photos · {done} of {total}", { done: num(p.done), total: num(p.total) })
    : null;
  if (!text) return null;
  return (
    <Pressable onPress={() => router.push("/search-settings")} style={[st.card, { backgroundColor: th.colors.surfaceVariant }]} accessibilityRole="button">
      <Text variant="bodyMedium">{text}</Text>
    </Pressable>
  );
}

function NoResults({ ready, on, onTips }: { ready: boolean; on: boolean; onTips: () => void }) {
  const th = useAppTheme();
  return (
    <View style={{ alignItems: "center", padding: 32 }}>
      <Text variant="titleMedium" style={{ marginBottom: 8 }}>{t("Nothing found")}</Text>
      <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, maxWidth: 320 }}>
        {!on ? t("Turn on search to find photos by what's in them. Names, dates and file names work without it.") : !ready ? t("Search is still getting ready.") : t("Try other English words, like \"dog\" or \"mountains\".")}
      </Text>
      <Button mode="text" icon="help" onPress={onTips} style={{ marginTop: 8 }}>{t("Search tips")}</Button>
    </View>
  );
}

/** Above the photos ranked below the close matches, once they show. */
function SimilarHeading({ onHide }: { onHide: () => void }) {
  return (
    <View style={[st.heading, { paddingHorizontal: 8 }]}>
      <Text style={[text.heading, { flex: 1 }]} accessibilityRole="header">{t("Similar photos")}</Text>
      <Button compact onPress={onHide}>{t("Hide")}</Button>
    </View>
  );
}

function Heading({ title, action }: { title: string; action?: [string, () => void] }) {
  return (
    <View style={st.heading}>
      <Text style={[text.heading, { flex: 1 }]}>{title}</Text>
      {action ? <Button compact onPress={action[1]}>{action[0]}</Button> : null}
    </View>
  );
}

function Shortcut({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const th = useAppTheme();
  return (
    <Chip icon={() => <Icon name={icon} size={18} color={th.colors.primary} />} onPress={onPress} style={{ backgroundColor: th.colors.surfaceVariant }}>{label}</Chip>
  );
}

const st = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 8, padding: 16, borderRadius: radius.card },
  heading: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16 },
  hint: { paddingHorizontal: 16, paddingTop: 16 },
  similarRow: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  queryChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  moreSimilar: { alignItems: "center", paddingVertical: 16 },
  tipsButton: { alignSelf: "flex-start", marginHorizontal: 8, marginTop: 12 },
});
