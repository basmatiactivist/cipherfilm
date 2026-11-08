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
import { similarTo, useSearchProgress, type Progress } from "../search/engine";
import { usePeople } from "../search/people";
import { search, SUGGESTIONS, type Result } from "../search/query";
import { loadSettings, onSettingsChange, type SearchSettings } from "../search/settings";
import { useAppTheme } from "../ui";
import { radius, text } from "../tokens";
import { Loader } from "../Loader";

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** Search: one box for people, things, places in time, file names; below it people, shortcuts and ideas. */
export default function Search() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const params = useLocalSearchParams<{ similar?: string; q?: string }>();
  const { items } = useLibrary();
  const [q, setQ] = useState(params.q ?? "");
  const [res, setRes] = useState<Result | null>(null);
  const [similar, setSimilar] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const progress = useSearchProgress();
  const settings = useSettings();
  const { groups } = usePeople();
  const seq = useRef(0);
  useEffect(() => { if (!items) refreshLibrary(); }, []);

  // photos like one from the viewer
  useEffect(() => {
    if (!params.similar || !items) return;
    const byId = new Map(items.map((i) => [i.id, i]));
    const self = byId.get(params.similar);
    similarTo(params.similar).then((hits) => setSimilar([...(self ? [self] : []), ...hits.map((h) => byId.get(h.id)).filter((i): i is Item => !!i)]), () => setSimilar([]));
  }, [params.similar, items, progress.phase]);

  useEffect(() => {
    const mine = ++seq.current;
    if (!q.trim()) { setRes(null); setBusy(false); return; }
    setBusy(true);
    const h = setTimeout(() => {
      search(q, (items ?? []).filter((i) => !i.broken)).then((r) => { if (seq.current === mine) setRes(r); }, () => {}).finally(() => { if (seq.current === mine) setBusy(false); });
    }, 250);
    return () => clearTimeout(h);
  }, [q, items, progress.phase === "ready"]);

  const people = useMemo(() => (groups ?? []).filter((g) => !g.person?.hidden).sort((a, b) => Number(!!b.person?.name) - Number(!!a.person?.name) || b.items.length - a.items.length), [groups]);

  const bar = (
    <View style={{ paddingTop: inset.top + 8, paddingHorizontal: 16 + inset.left, paddingBottom: 8 }}>
      <Searchbar placeholder="Search your photos" value={q} onChangeText={(v) => { setQ(v); setSimilar(null); }}
        right={busy ? ({ style }) => <View style={[style, { marginRight: 16 }]}><Loader /></View> : undefined}
        icon="search" clearIcon="x" style={{ backgroundColor: t.colors.surfaceVariant }} inputStyle={{ minHeight: 0 }}
        autoCorrect={false} returnKeyType="search" accessibilityLabel="Search your photos"
        searchAccessibilityLabel="Search" clearAccessibilityLabel="Clear the search" />
      {res?.how.length ? <Text variant="bodySmall" style={{ marginTop: 8, color: t.colors.onSurfaceVariant }}>{res.items.length} {res.items.length === 1 ? "result" : "results"} · {res.how.join(" · ")}</Text> : null}
      {similar ? (
        <View style={st.similarRow}>
          <Text style={[text.heading, { flex: 1 }]}>Photos like this one</Text>
          <Button compact onPress={() => { setSimilar(null); router.setParams({ similar: "" }); }}>Close</Button>
        </View>
      ) : null}
    </View>
  );

  // the search box stays mounted while results replace the ideas below it, so typing keeps its focus
  if (q.trim() || similar) {
    const shown = similar ?? res?.items ?? null;
    return (
      <View style={{ flex: 1, backgroundColor: t.colors.background }}>
        {bar}
        <Gallery items={shown} loading={false} onRefresh={() => {}} flat within="search" bottom={NAV_HEIGHT}
          header={res?.people.length && !similar ? (
            <FlatList horizontal data={res.people} keyExtractor={(g) => g.key} contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }} style={{ flexGrow: 0, marginBottom: 4 }}
              renderItem={({ item: g }) => <FaceAvatar group={g} size={56} onPress={() => router.push({ pathname: "/person/[key]", params: { key: g.key } })} />} />
          ) : null}
          empty={busy ? null : <NoResults ready={progress.phase === "ready" || progress.phase === "indexing"} on={!!settings?.enabled} />}
          nav={<NavBar current="search" />} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      {bar}
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + NAV_HEIGHT + 24 }} keyboardShouldPersistTaps="handled">
        {settings && !settings.enabled ? <TurnOn /> : <Status p={progress} />}
        {settings?.enabled && settings.faces && people.length ? (
          <>
            <Heading title="People" action={["See all", () => router.push("/people")]} />
            <FlatList horizontal data={people.slice(0, 20)} keyExtractor={(g) => g.key} contentContainerStyle={{ paddingHorizontal: 8, gap: 4 }} showsHorizontalScrollIndicator={false}
              renderItem={({ item: g }) => <FaceAvatar group={g} onPress={() => router.push({ pathname: "/person/[key]", params: { key: g.key } })} />} />
          </>
        ) : null}
        <Heading title="Your photos" />
        <View style={st.chips}>
          <Shortcut icon="heart" label="Favorites" onPress={() => router.push("/favorites")} />
          <Shortcut icon="video" label="Videos" onPress={() => setQ("videos")} />
          <Shortcut icon="phone" label="Screenshots" onPress={() => setQ("screenshots")} />
          <Shortcut icon="photos" label={String(new Date().getFullYear() - 1)} onPress={() => setQ(String(new Date().getFullYear() - 1))} />
        </View>
        {settings?.enabled ? (
          <>
            <Heading title="Try" />
            <View style={st.chips}>
              {SUGGESTIONS.map((s) => <Chip key={s} onPress={() => setQ(s)} style={{ backgroundColor: t.colors.surfaceVariant }} compact>{s}</Chip>)}
            </View>
            <Text variant="bodySmall" style={[st.hint, { color: t.colors.onSurfaceVariant }]}>
              Search in English for what's in a photo, or by names, dates ("july 2023"), file names and cameras.
            </Text>
          </>
        ) : null}
      </ScrollView>
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
  const t = useAppTheme();
  return (
    <View style={[st.card, { backgroundColor: t.colors.primaryContainer }]}>
      <Text style={[text.heading, { marginBottom: 4 }]}>Search what's in your photos</Text>
      <Text variant="bodyMedium" style={{ color: t.colors.onPrimaryContainer }}>
        Find "beach", "birthday cake" or the people in your photos. It runs on this phone; the server never sees what your photos show.
      </Text>
      <Button mode="contained" style={{ marginTop: 12, alignSelf: "flex-start" }} onPress={() => router.push("/search-settings")}>Set up search</Button>
    </View>
  );
}

function Status({ p }: { p: Progress }) {
  const t = useAppTheme();
  if (p.phase === "ready" || p.phase === "off") return null;
  const text = p.phase === "download" ? `Downloading the search models · ${mb(p.done)} of ${mb(p.total)}`
    : p.phase === "waitWifi" ? `Waiting for Wi-Fi to download the search models${p.total ? ` (${mb(p.total)})` : ""}.`
    : p.phase === "loading" ? (p.total ? `Getting search ready · ${p.done} of ${p.total}` : p.message ? `${p.message}…` : "Getting search ready…")
    : p.phase === "indexing" ? `Indexing for search · ${p.done} of ${p.total}`
    : `Search stopped: ${p.message ?? "something went wrong"}`;
  return (
    <Pressable onPress={() => router.push("/search-settings")} style={[st.card, { backgroundColor: t.colors.surfaceVariant }]} accessibilityRole="button">
      <Text variant="bodyMedium">{text}</Text>
      {p.phase === "download" || p.phase === "indexing" || p.phase === "loading" ? (
        <ProgressBar progress={p.total ? p.done / p.total : 0} indeterminate={p.phase === "loading" && !p.total} color={t.colors.primary} style={{ height: 5, borderRadius: 3, marginTop: 10, backgroundColor: t.colors.outlineVariant }} />
      ) : null}
      {p.phase === "indexing" ? <Text variant="bodySmall" style={{ marginTop: 8, color: t.colors.onSurfaceVariant }}>Results improve as it goes.</Text> : null}
    </Pressable>
  );
}

function NoResults({ ready, on }: { ready: boolean; on: boolean }) {
  const t = useAppTheme();
  return (
    <View style={{ alignItems: "center", padding: 32 }}>
      <Text variant="titleMedium" style={{ marginBottom: 8 }}>Nothing found</Text>
      <Text variant="bodyMedium" style={{ textAlign: "center", color: t.colors.onSurfaceVariant, maxWidth: 320 }}>
        {!on ? "Turn on search to find photos by what's in them. Names, dates and file names work without it." : !ready ? "Search is still getting ready." : "Try other English words, like \"dog\" or \"mountains\"."}
      </Text>
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
  const t = useAppTheme();
  return (
    <Chip icon={() => <Icon name={icon} size={18} color={t.colors.primary} />} onPress={onPress} style={{ backgroundColor: t.colors.surfaceVariant }}>{label}</Chip>
  );
}

const st = StyleSheet.create({
  card: { marginHorizontal: 16, marginVertical: 8, padding: 16, borderRadius: radius.card },
  heading: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16 },
  hint: { paddingHorizontal: 16, paddingTop: 16 },
  similarRow: { flexDirection: "row", alignItems: "center", marginTop: 8 },
});
