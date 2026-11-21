// "Your reviews" on Photos, above "Your years": the custom reviews (reviews.ts) as cards, due ones first, each with one
// of its photos. A card plays the review (app/review/[id].tsx). Not there while Memories is off on this phone, nor for
// a review whose search finds nothing here.
import { useEffect, useState } from "react";
import { router } from "expo-router";
import { isDue, reviewSlides } from "@memories/custom";
import { CardRow, type Card } from "./CardRow";
import type { Item } from "./library";
import { useMemoriesOn } from "./memories";
import { dueLabel, runReview, useReviews } from "./reviews";
import { indexVersion } from "./search/engine";
import { t } from "./i18n";

export function useReviewCards(items: Item[] | null): Card[] {
  const on = useMemoriesOn();
  const { doc, shown } = useReviews();
  const [cards, setCards] = useState<Card[]>([]);
  const index = indexVersion();
  useEffect(() => {
    if (!on || !items || !shown?.length) { setCards([]); return; }
    let live = true;
    (async () => {
      const now = new Date();
      const out: { due: boolean; card: Card }[] = [];
      for (const r of shown) {
        const run = await runReview(r, items, now).catch(() => null);
        if (!live) return;
        if (!run?.picked.length) continue;
        const first = reviewSlides(r, run.picked, run.matches.length)[0];
        out.push({
          due: isDue(r, doc, now),
          card: {
            key: r.id, cover: first.kind === "rcover" ? first.item : run.picked[0], title: r.name, sub: dueLabel(r, doc, now),
            onPress: () => router.push({ pathname: "/review/[id]", params: { id: r.id } }),
          },
        });
      }
      // due first, otherwise in the order they were made
      out.sort((a, b) => Number(b.due) - Number(a.due));
      if (live) setCards(out.map((x) => x.card));
    })();
    return () => { live = false; };
  }, [on, items, shown, doc, index]);
  return cards;
}

export const ReviewsRow = ({ cards }: { cards: Card[] }) => <CardRow title={t("Your reviews")} cards={cards} />;
