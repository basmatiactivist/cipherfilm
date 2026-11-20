// A custom review as a story (reviews.ts, StoryPlayer.tsx): its cover, this period's photos year by year, the end.
// Opening it counts as watching it for this period (once): it isn't due again until the next, which shows other photos.
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button, Text } from "react-native-paper";
import { reviewSlides, type ReviewSlide } from "@memories/custom";
import type { Item } from "../../library";
import { refreshLibrary, useLibrary } from "../../libraryStore";
import { nextOneLabel, periodLabel, runReview, useReviews, watch, type Review } from "../../reviews";
import { reviewSlideItems, reviewSlideMs } from "../../reviewStory";
import { SOFT, StoryPlayer, storyStyles as st, WHITE } from "../../StoryPlayer";
import { dark } from "../../tokens";
import { t, tn } from "../../i18n";

type S = ReviewSlide<Item>;

export default function ReviewStory() {
  const id = String(useLocalSearchParams<{ id: string }>().id);
  const { items } = useLibrary();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  const { shown, needsModel, error } = useReviews();
  const r = shown?.find((x) => x.id === id);
  const [slides, setSlides] = useState<S[] | null>(null);
  const watched = useRef(false);

  useEffect(() => {
    if (!items || shown === null) return;
    if (!r) { setSlides([]); return; }
    let live = true;
    runReview(r, items).then(({ matches, picked }) => {
      if (!live) return;
      setSlides(picked.length ? reviewSlides(r, picked, matches.length) : []);
      // watched: once per opening, and only once per period in the document (watch checks)
      if (picked.length && !watched.current) { watched.current = true; watch(r, picked).catch(() => {}); }
    }, () => live && setSlides([]));
    return () => { live = false; };
  }, [items, shown === null, r?.id, r?.updated]);

  const empty = error ?? (r ? t("No photos match this review yet.") : needsModel ? t("Custom reviews need search set up on this phone.") : t("This review isn't here any more."));
  return (
    <StoryPlayer slides={slides} title={r?.name ?? ""} label={r?.name ?? t("Custom reviews")} emptyText={empty}
      ms={reviewSlideMs} items={reviewSlideItems} describe={(s) => describe(s, r)}
      text={(s, c) => r ? <SlideText slide={s} review={r} again={c.again} close={c.close} /> : null} />
  );
}

function SlideText({ slide, review, again, close }: { slide: S; review: Review; again: () => void; close: () => void }) {
  const period = useMemo(() => periodLabel(review.every), [review.every]);
  switch (slide.kind) {
    case "rcover":
      return (
        <View>
          <Text style={[st.caption, { color: SOFT, marginBottom: 4 }]}>{period}</Text>
          <Text numberOfLines={3} style={[st.serif, { fontSize: 44, lineHeight: 50, color: WHITE }]}>{slide.name}</Text>
          <Text style={[st.caption, { color: SOFT, marginTop: 6 }]}>{tn(slide.total, "{shown} of {n} photo", "{shown} of {n} photos", { shown: slide.shown })}</Text>
        </View>
      );
    case "ryear":
      return (
        <View>
          <Text style={[st.serif, { fontSize: 40, lineHeight: 46, color: WHITE }]}>{String(slide.year)}</Text>
          <Text style={[st.caption, { color: SOFT }]}>{tn(slide.photos.length, "{n} photo", "{n} photos")}</Text>
        </View>
      );
    case "rend":
      return (
        <View style={{ marginBottom: "30%" }}>
          <Text style={[st.serif, { fontSize: 36, lineHeight: 42, color: WHITE, marginBottom: 28 }]}>{nextOneLabel(review.every)}</Text>
          <Button mode="contained" onPress={again} contentStyle={{ height: 48 }} buttonColor={dark.teal} textColor={dark.onTeal}>{t("Watch again")}</Button>
          <Button mode="outlined" onPress={() => router.replace({ pathname: "/reviews/edit", params: { id: review.id } })} contentStyle={{ height: 48 }} textColor={WHITE}
            style={{ marginTop: 12, borderColor: "rgba(255,255,255,0.4)" }}>{t("Edit")}</Button>
          <Button mode="text" onPress={close} contentStyle={{ height: 48 }} textColor={SOFT} style={{ marginTop: 4 }}>{t("Close")}</Button>
        </View>
      );
  }
}

/** What a screen reader says for a slide. */
function describe(s: S, r: Review | undefined): string {
  switch (s.kind) {
    case "rcover": return `${s.name}. ${r ? periodLabel(r.every) : ""}, ${tn(s.total, "{shown} of {n} photo", "{shown} of {n} photos", { shown: s.shown })}`;
    case "ryear": return `${s.year}, ${tn(s.photos.length, "{n} photo", "{n} photos")}`;
    case "rend": return r ? nextOneLabel(r.every) : "";
  }
}
