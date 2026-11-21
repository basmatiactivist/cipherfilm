import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { Button, Text } from "react-native-paper";
import { yearRecap } from "@memories/recap";
import { Icon } from "../../../icons";
import type { Item } from "../../../library";
import { refreshLibrary, useLibrary } from "../../../libraryStore";
import { faceUri, usePeople, type Group } from "../../../search/people";
import { slideItems, slideMs, storySlides, type Slide } from "../../../recapStory";
import { tripTitle, usePlaceLookup, useTrips } from "../../../trips";
import { cap, SOFT, StoryPlayer, storyStyles, WHITE } from "../../../StoryPlayer";
import { dark } from "../../../tokens";
import { locale, t, tn } from "../../../i18n";

/** The year in review as a story (StoryPlayer.tsx plays it; recapStory.ts has the slides). */
export default function RecapStory() {
  const year = Number(useLocalSearchParams<{ year: string }>().year);
  const { items } = useLibrary();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  const lookup = usePlaceLookup();
  const { groups } = usePeople();
  const named = useMemo(() => (groups ?? []).filter((g) => g.person?.name && !g.person.hidden), [groups]);
  const tripsAll = useTrips(items);
  const slides = useMemo(() => {
    if (!items) return null;
    const r = yearRecap(items, year, { lookup: lookup ?? undefined, people: named });
    if (!r) return [];
    const trips = (tripsAll ?? []).filter((x) => new Date(x.start).getFullYear() === year || new Date(x.end).getFullYear() === year)
      .map((x) => ({ key: x.key, title: tripTitle(x), start: x.start, items: x.items }));
    return storySlides(r, trips, new Set(named.map((g) => g.key)));
  }, [items, year, lookup, named, tripsAll]);
  const people = useMemo(() => new Map(named.map((g) => [g.key, g])), [named]);
  const monthName = new Intl.DateTimeFormat(locale(), { month: "long" });

  return (
    <StoryPlayer slides={slides} title={String(year)} label={t("{year} in review", { year })} emptyText={t("No photos from {year}.", { year })}
      ms={slideMs} items={slideItems} describe={(s) => describeSlide(s, year, monthName, people)}
      text={(slide, c) => (
        <SlideText slide={slide} year={year} monthName={monthName} people={people}
          onPerson={(key) => { router.push({ pathname: "/person/[key]", params: { key } }); }}
          again={c.again} all={() => router.replace({ pathname: "/recap/[year]", params: { year: String(year) } })} close={c.close} />
      )} />
  );
}

function SlideText({ slide, year, monthName, people, onPerson, again, all, close }: {
  slide: Slide<Item>; year: number; monthName: Intl.DateTimeFormat; people: Map<string, Group>;
  onPerson: (key: string) => void; again: () => void; all: () => void; close: () => void;
}) {
  switch (slide.kind) {
    case "cover":
      return (
        <View>
          <Text style={[st.serif, { fontSize: 76, lineHeight: 82, color: WHITE }]}>{String(year)}</Text>
          <Text style={[st.serif, { fontSize: 22, lineHeight: 28, color: WHITE, marginTop: 4 }]}>{t("Your year in pictures")}</Text>
        </View>
      );
    case "month":
      return (
        <View>
          <Text style={[st.serif, { fontSize: 40, lineHeight: 46, color: WHITE }]}>{cap(monthName.format(new Date(year, slide.month, 1)))}</Text>
          <Text style={[st.caption, { color: SOFT }]}>{tn(slide.total, "{n} item", "{n} items")}</Text>
        </View>
      );
    case "trip":
      return (
        <View>
          <Text style={[st.caption, { color: SOFT, marginBottom: 4 }]}>{t("Trip")}</Text>
          <Text style={[st.serif, { fontSize: 32, lineHeight: 38, color: WHITE }]}>{slide.title}</Text>
          <Text style={[st.caption, { color: SOFT }]}>{tn(slide.count, "{n} item", "{n} items")}</Text>
        </View>
      );
    case "places":
      return (
        <View>
          <Text style={[st.caption, { color: SOFT, marginBottom: 4 }]}>{t("Where you were most")}</Text>
          <Text style={[st.serif, { fontSize: 34, lineHeight: 40, color: WHITE }]}>{slide.top.name}</Text>
          <Text style={[st.caption, { color: SOFT }]}>{slide.top.country}</Text>
          {slide.others.length ? <Text style={[st.caption, { color: SOFT, marginTop: 12 }]}>{t("Also: {places}", { places: slide.others.join(" · ") })}</Text> : null}
        </View>
      );
    case "people":
      return (
        <View style={{ marginBottom: "40%" }}>
          <Text style={[st.serif, { fontSize: 32, lineHeight: 38, color: WHITE, marginBottom: 24 }]}>{t("With you this year")}</Text>
          <View style={st.faces}>
            {slide.people.map((p) => { const g = people.get(p.key); return g ? <StoryFace key={p.key} group={g} count={p.count} onPress={() => onPerson(p.key)} /> : null; })}
          </View>
        </View>
      );
    case "end":
      return (
        <View style={{ marginBottom: "30%" }}>
          <Text style={[st.serif, { fontSize: 40, lineHeight: 46, color: WHITE, marginBottom: 28 }]}>{t("That was {year}", { year })}</Text>
          <Button mode="contained" onPress={again} contentStyle={{ height: 48 }} buttonColor={dark.teal} textColor={dark.onTeal}>{t("Watch again")}</Button>
          <Button mode="outlined" onPress={all} contentStyle={{ height: 48 }} textColor={WHITE} style={{ marginTop: 12, borderColor: "rgba(255,255,255,0.4)" }}>{t("All highlights")}</Button>
          <Button mode="text" onPress={close} contentStyle={{ height: 48 }} textColor={SOFT} style={{ marginTop: 4 }}>{t("Close")}</Button>
        </View>
      );
  }
}

function StoryFace({ group, count, onPress }: { group: Group; count: number; onPress: () => void }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (group.cover) faceUri(group.cover).then((u) => live && setUri(u), () => {});
    return () => { live = false; };
  }, [group.cover?.key]);
  const name = group.person?.name ?? "";
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tn(count, "{name}, {n} photo", "{name}, {n} photos", { name })} style={({ pressed }) => [st.face, { opacity: pressed ? 0.8 : 1 }]}>
      <View style={st.faceDisc}>
        {uri ? <Image source={{ uri }} style={{ width: 84, height: 84 }} cachePolicy="memory" transition={150} /> : <Icon name="user" size={34} color={SOFT} />}
      </View>
      <Text numberOfLines={1} style={[st.label, { color: WHITE, marginTop: 8 }]}>{name}</Text>
      <Text style={[st.small, { color: SOFT }]}>{tn(count, "{n} photo", "{n} photos")}</Text>
    </Pressable>
  );
}

/** What a screen reader says for a slide. */
function describeSlide(s: Slide<Item>, year: number, month: Intl.DateTimeFormat, people: Map<string, Group>): string {
  switch (s.kind) {
    case "cover": return `${t("{year} in review", { year })}. ${t("Your year in pictures")}`;
    case "month": return `${cap(month.format(new Date(year, s.month, 1)))} ${year}, ${tn(s.total, "{n} item", "{n} items")}`;
    case "trip": return `${t("Trip")}: ${s.title}, ${tn(s.count, "{n} item", "{n} items")}`;
    case "places": return `${t("Where you were most")}: ${s.top.name}, ${s.top.country}`;
    case "people": return `${t("With you this year")}: ${s.people.map((p) => people.get(p.key)?.person?.name).filter(Boolean).join(", ")}`;
    case "end": return t("That was {year}", { year });
  }
}

const st = StyleSheet.create({
  ...storyStyles,
  faces: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  face: { width: 96, alignItems: "center" },
  faceDisc: { width: 84, height: 84, borderRadius: 42, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.12)" },
});
