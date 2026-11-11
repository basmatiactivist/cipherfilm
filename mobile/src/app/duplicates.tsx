import { useEffect, useMemo, useState } from "react";
import { FlatList, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, Portal, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bytesOf, chosenWith, type Found, type Group } from "@cleanup/duplicates";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { refreshAlbums } from "../albumsStore";
import { api } from "../api";
import { findDuplicates } from "../duplicates";
import { indexedAmong, pairScores, searchReady, useSearchProgress } from "../search/engine";
import { demoNote, useSession } from "../session";
import type { Item } from "../library";
import { Tile } from "../Tile";
import { Icon } from "../icons";
import { Problem, useAppTheme } from "../ui";
import { radius, text } from "../tokens";
import { busyIcon, Loading } from "../Loader";
import { locale, t, tn } from "../i18n";

const TILE = 112;
const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB` : `${Math.max(n > 0 ? 1 : 0, Math.round(n / 1e6)).toLocaleString(locale())} MB`);
const mb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString(locale(), { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1e3)).toLocaleString(locale())} KB`);

/** Duplicates and similar photos: found on this phone from the decrypted list and the search index (the vectors stay
 *  in native memory); the server learns nothing new. What is chosen goes to the trash (restorable for 30 days). */
export default function Duplicates() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const demo = !!useSession().me?.demo;
  const { items, error: libraryError, loadedAt } = useLibrary();
  const phase = useSearchProgress().phase;
  // decided on the server's list as it is now, never a cached or older one (trashed elsewhere meanwhile)
  const [opened] = useState(Date.now);
  const fresh = loadedAt >= opened && !libraryError;
  const [found, setFound] = useState<(Found & { searchOn: boolean }) | null>(null);
  const [changed, setChanged] = useState<Map<string, boolean>>(new Map());
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[] | null>(null);

  useEffect(() => { refreshLibrary(); }, []);
  // again when the list changes, and once search becomes ready (the index opens a moment after unlocking)
  const ready = phase === "ready" || phase === "indexing" ? searchReady() : false;
  useEffect(() => {
    if (!items || !fresh) return;
    let live = true;
    findDuplicates(items, { ready: searchReady(), indexedAmong, pairScores })
      .then((f) => { if (live) { setFound(f); setError(undefined); } }, (e) => live && setError(e instanceof Error ? e.message : t("That didn't work.")));
    return () => { live = false; };
  }, [items, fresh, ready]);

  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const groups = useMemo(() => (found ? [...found.exact, ...found.similar] : []), [found]);
  const chosen = useMemo(() => chosenWith(groups, changed), [groups, changed]);
  const live = [...chosen].filter((id) => byId.has(id));
  const bytes = bytesOf(live, (id) => byId.get(id)?.size ?? 0);
  const toggle = (id: string) => setChanged((m) => new Map(m).set(id, !chosen.has(id)));

  const move = async () => {
    setAsking(false); setBusy(true); setError(undefined);
    const ids = live;
    try {
      for (let i = 0; i < ids.length; i += 500) await api("POST", "/api/items/trash", { item_ids: ids.slice(i, i + 500) });
      setDone(ids);
      await refreshLibrary();
      refreshAlbums();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("That didn't work."));
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    const ids = done ?? [];
    setBusy(true); setError(undefined);
    try {
      for (let i = 0; i < ids.length; i += 500) await api("POST", "/api/items/restore", { item_ids: ids.slice(i, i + 500) });
      setDone(null);
      await refreshLibrary();
      refreshAlbums();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("That didn't work."));
    } finally {
      setBusy(false);
    }
  };

  const missing = found ? found.images - found.indexed : 0;
  const header = found ? (
    <View>
      <View style={[st.card, { backgroundColor: live.length ? th.colors.primaryContainer : th.colors.surfaceVariant }]}>
        <View style={st.row}>
          <Icon name="similar" size={28} color={th.colors.primary} />
          <View style={{ flex: 1 }}>
            <Text variant="headlineSmall">{groups.length ? gb(bytes) : t("No duplicates found")}</Text>
            <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant }}>
              {groups.length ? t("{n} chosen to move to the trash", { n: live.length.toLocaleString(locale()) }) : t("Nothing in your library is there twice, and no photos look nearly the same.")}
            </Text>
          </View>
        </View>
        {!found.searchOn ? (
          <>
            <Text variant="bodySmall" style={{ marginTop: 8 }}>{t("Exact duplicates only. Turn on search to also find similar photos (bursts, near-identical shots).")}</Text>
            <Button mode="outlined" compact onPress={() => router.push("/search-settings")} style={{ marginTop: 8, alignSelf: "flex-start" }}>{t("Search and people")}</Button>
          </>
        ) : missing > 0 ? (
          <Text variant="bodySmall" style={{ marginTop: 8 }}>{t("{indexed} of {total} photos are indexed. Index more photos to find more.", { indexed: found.indexed.toLocaleString(locale()), total: found.images.toLocaleString(locale()) })}</Text>
        ) : null}
        {demo ? <Text variant="labelLarge" style={{ color: th.colors.primary, marginTop: 8 }}>{demoNote()}</Text> : groups.length ? (
          <Button mode="contained" icon={busy ? busyIcon : "trash"} disabled={!live.length || busy} onPress={() => setAsking(true)} style={st.button}>
            {t("Move {n} to trash", { n: live.length.toLocaleString(locale()) })}
          </Button>
        ) : null}
      </View>
      {done ? (
        <View style={[st.hint, st.row]}>
          <Text variant="bodyMedium" style={{ flex: 1 }}>{tn(done.length, "Moved {n} item to the trash.", "Moved {n} items to the trash.")}</Text>
          <Button compact onPress={undo} disabled={busy}>{t("Undo")}</Button>
        </View>
      ) : null}
      <View style={{ paddingHorizontal: 16 }}><Problem>{error}</Problem></View>
      {groups.length ? <Text variant="bodySmall" style={[st.hint, { color: th.colors.onSurfaceVariant }]}>{t("The suggested one to keep in each group is marked. Tap a photo to change the choice.")}</Text> : null}
    </View>
  ) : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Duplicates and similar photos")} titleStyle={text.page} />
      </Appbar.Header>
      {!found && (libraryError || error) ? (
        <View style={{ padding: 16 }}><Problem>{libraryError ? t("Couldn't load your library, so nothing can be removed. {error}", { error: libraryError }) : error}</Problem></View>
      ) : !found ? (
        <Loading label={t("Looking for duplicates and similar photos…")} />
      ) : (
        <FlatList
          data={groups} keyExtractor={(g) => g.ids.join()} ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: inset.bottom + 32 }} initialNumToRender={6} windowSize={5}
          renderItem={({ item: g }) => <GroupRow group={g} byId={byId} chosen={chosen} toggle={toggle} />} />
      )}
      <Portal>
        <Dialog visible={asking} onDismiss={() => setAsking(false)}>
          <Dialog.Title>{t("Move {n} to the trash?", { n: live.length.toLocaleString(locale()) })}</Dialog.Title>
          <Dialog.Content><Text variant="bodyMedium">{t("They can be restored from the trash for 30 days. Until then they count toward your storage.")}</Text></Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsking(false)}>{t("Cancel")}</Button>
            <Button onPress={move}>{t("Move to trash")}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

function GroupRow({ group, byId, chosen, toggle }: { group: Group; byId: Map<string, Item>; chosen: Set<string>; toggle: (id: string) => void }) {
  const th = useAppTheme();
  const kept = group.ids.filter((id) => !chosen.has(id)).length;
  return (
    <View style={st.group}>
      <Text variant="titleSmall" style={st.groupTitle}>{group.kind === "exact" ? t("Same file, uploaded more than once") : t("Similar, taken within minutes")}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
        {group.ids.map((id) => {
          const it = byId.get(id);
          if (!it) return null;
          const on = chosen.has(id);
          const m = it.meta;
          return (
            <View key={id} style={{ width: TILE }}>
              <Tile item={it} size={TILE} selecting selected={on} onPress={() => toggle(id)} onLongPress={() => toggle(id)} />
              <Text variant="labelMedium" style={{ marginTop: 4, color: on ? th.colors.error : th.colors.primary }}>{on ? t("To the trash") : t("Keep")}</Text>
              <Text variant="bodySmall" numberOfLines={2} style={{ color: th.colors.onSurfaceVariant }}>
                {[m?.width && m?.height ? `${m.width}×${m.height}` : "", mb(it.size), m?.gps ? t("location") : ""].filter(Boolean).join(" · ")}
              </Text>
            </View>
          );
        })}
      </ScrollView>
      {kept === 0 ? <Text variant="bodySmall" style={[st.hint, { color: th.colors.error }]}>{t("All of this group is chosen: none would be kept.")}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  card: { margin: 16, padding: 16, borderRadius: radius.card },
  row: { flexDirection: "row", alignItems: "center", gap: 16 },
  button: { marginTop: 16, alignSelf: "flex-start" },
  hint: { paddingHorizontal: 16, paddingVertical: 4 },
  group: { paddingVertical: 12 },
  groupTitle: { paddingHorizontal: 16, paddingBottom: 8 },
});
