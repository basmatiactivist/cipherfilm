// The year recaps on Photos, under "On this day": one card per earlier year (and this one from December). A card
// plays that year in review as a story (app/recap/story/[year].tsx).
import { useMemo } from "react";
import { router } from "expo-router";
import { highlights } from "@memories/recap";
import { CardRow } from "./CardRow";
import type { Item } from "./library";
import { t, tn } from "./i18n";

export function RecapRow({ years, items }: { years: number[]; items: Item[] }) {
  const cards = useMemo(() => years.map((year) => {
    const list = items.filter((i) => !i.broken && !i.trashed_at && new Date(i.meta?.capture_ts ?? i.created_at * 1000).getFullYear() === year);
    const favs = list.filter((i) => i.favorite);
    const cover = highlights(favs.length ? favs : list, 1)[0] ?? list[0];
    return {
      key: String(year), cover, title: String(year), sub: t("In review"),
      label: `${t("{year} in review", { year })}, ${tn(list.length, "{n} item", "{n} items")}`,
      onPress: () => router.push({ pathname: "/recap/story/[year]", params: { year: String(year) } }),
    };
  }), [years, items]);
  return <CardRow title={t("Your years")} cards={cards} />;
}
