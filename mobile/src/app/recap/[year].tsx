import { useEffect, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Appbar, Chip, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { yearRecap } from "@memories/recap";
import { ThumbView } from "../../../modules/cf-native/src/CfNativeModule";
import { CardRow } from "../../CardRow";
import { Icon } from "../../icons";
import type { Item } from "../../library";
import { refreshLibrary, useLibrary } from "../../libraryStore";
import { usePeople } from "../../search/people";
import { tripTitle, usePlaceLookup, useTrips } from "../../trips";
import { setViewerList } from "../../viewerList";
import { Loading } from "../../Loader";
import { useAppTheme } from "../../ui";
import { radius, space, text } from "../../tokens";
import { locale, t, tn } from "../../i18n";

/** A year in review: how many photos and videos, the places and people seen most, its trips, and a few photos of
 *  each month (web/src/memories/recap.ts). Worked out on this phone. */
export default function RecapScreen() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const year = Number(useLocalSearchParams<{ year: string }>().year);
  const { items } = useLibrary();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  const lookup = usePlaceLookup();
  const { groups } = usePeople();
  const named = useMemo(() => (groups ?? []).filter((g) => g.person?.name && !g.person.hidden), [groups]);
  const r = useMemo(() => (items ? yearRecap(items, year, { lookup: lookup ?? undefined, people: named }) : null), [items, year, lookup, named]);
  const trips = (useTrips(items) ?? []).filter((x) => new Date(x.start).getFullYear() === year || new Date(x.end).getFullYear() === year);
  const month = new Intl.DateTimeFormat(locale(), { month: "long" });
  const tile = Math.floor((width - inset.left - inset.right - 16 * 2 - space.s2 * 3) / 4);
  const open = (list: Item[], i: number) => {
    setViewerList(list.map((x) => x.id));
    router.push({ pathname: "/photo/[id]", params: { id: list[i].id, within: "memory" } });
  };
  const byKey = new Map(named.map((g) => [g.key, g]));
  const facts = r ? [tn(r.photos, "{n} photo", "{n} photos"), r.videos ? tn(r.videos, "{n} video", "{n} videos") : "", tn(r.days, "{n} day", "{n} days"), r.countries > 1 ? tn(r.countries, "{n} country", "{n} countries") : ""].filter(Boolean).join(" · ") : "";

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("{year} in review", { year })} titleStyle={text.page} />
      </Appbar.Header>
      {!items ? <Loading label={t("Opening your library…")} /> : !r ? (
        <View style={st.empty}>
          <Icon name="photos" size={32} color={th.colors.onSurfaceVariant} />
          <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, marginTop: 12 }}>{t("No photos from {year}.", { year })}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16 + inset.left, paddingBottom: inset.bottom + 32, gap: space.s4 }}>
          <Text style={[text.heading, { paddingHorizontal: space.s1 }]}>{facts}</Text>
          {!lookup ? <Loading inline label={t("Naming places…")} /> : null}
          <CardRow title={t("Places")} cards={r.places.map((p) => ({ key: p.name + p.countryCode, cover: p.cover, title: p.name, sub: `${p.country} · ${tn(p.count, "{n} item", "{n} items")}` }))} />
          {r.people.length ? (
            <View>
              <Text style={[text.heading, st.head]} accessibilityRole="header">{t("People")}</Text>
              <View style={st.chips}>
                {r.people.map((p) => (
                  <Chip key={p.key} icon="user" onPress={() => router.push({ pathname: "/person/[key]", params: { key: p.key } })}>{`${byKey.get(p.key)?.person?.name ?? ""} · ${p.count}`}</Chip>
                ))}
              </View>
            </View>
          ) : null}
          <CardRow title={t("Trips")} cards={trips.map((x) => ({ key: x.key, cover: x.items[0], title: tripTitle(x), sub: tn(x.items.length, "{n} item", "{n} items"), onPress: () => router.push({ pathname: "/trip/[key]", params: { key: x.key } }) }))} size={140} />
          {r.months.map((m) => (
            <View key={m.month}>
              <Text style={[text.heading, st.head]} accessibilityRole="header">{`${month.format(new Date(year, m.month, 1))} · ${tn(m.total, "{n} item", "{n} items")}`}</Text>
              <View style={st.tiles}>
                {m.highlights.map((it, i) => (
                  <Pressable key={it.id} onPress={() => open(m.highlights, i)} accessibilityRole="button" accessibilityLabel={t("Open {name}", { name: it.meta?.name ?? "" })}>
                    {({ pressed }) => (
                      <View style={[st.tile, { width: tile, height: tile, backgroundColor: th.colors.surfaceVariant, opacity: pressed ? 0.85 : 1 }]}>
                        {it.has_thumb && !it.broken ? <ThumbView item={it.id} style={StyleSheet.absoluteFill} /> : <Icon name={it.kind === "video" ? "video" : "photos"} size={24} color={th.colors.onSurfaceVariant} />}
                      </View>
                    )}
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  head: { paddingHorizontal: space.s1, paddingBottom: space.s2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.s2, paddingHorizontal: space.s1 },
  tiles: { flexDirection: "row", gap: space.s2 },
  tile: { borderRadius: radius.tile, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
});
