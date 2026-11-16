import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Appbar, Button, Text } from "react-native-paper";
import { savedAs } from "@memories/trips";
import { Gallery } from "../../Gallery";
import { Icon } from "../../icons";
import { refreshLibrary, useLibrary } from "../../libraryStore";
import { refreshAlbums, useAlbums } from "../../albumsStore";
import { addToAlbum, createAlbum } from "../../albums";
import { tripTitle, useTrips } from "../../trips";
import { Problem, useAppTheme } from "../../ui";
import { space, text } from "../../tokens";
import { busyIcon } from "../../Loader";
import { demoNote, useSession } from "../../session";
import { locale, t, tn } from "../../i18n";

/** A suggested trip: its photos, and saving it as an ordinary encrypted album (or opening the album it was saved as). */
export default function TripScreen() {
  const th = useAppTheme();
  const { key } = useLocalSearchParams<{ key: string }>();
  const { items, error, loading } = useLibrary();
  const { albums } = useAlbums();
  const demo = !!useSession().me?.demo;
  const trips = useTrips(items);
  const trip = trips?.find((x) => x.key === key);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  useEffect(() => { if (!albums) refreshAlbums(); if (!items) refreshLibrary(); }, []);
  const saved = trip && albums ? savedAs(trip, albums) : undefined;
  const save = async () => {
    if (!trip || busy) return;
    setBusy(true); setProblem(undefined);
    try {
      const a = await createAlbum(tripTitle(trip));
      await addToAlbum(a.id, trip.items.map((i) => i.id));
      await refreshAlbums();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : t("Couldn't save the album."));
    } finally {
      setBusy(false);
    }
  };
  const day = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" });
  return (
    <Gallery
      items={trips === null ? null : trip ? trip.items : []} error={error} loading={loading} onRefresh={refreshLibrary} within="trip"
      header={
        <Appbar.Header style={{ backgroundColor: th.colors.background }}>
          <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
          <Appbar.Content title={trip ? tripTitle(trip) : t("Trip")} titleStyle={text.page} />
        </Appbar.Header>
      }
      top={trip ? (
        <View style={st.top}>
          <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant }}>
            {`${day.format(trip.start)} – ${day.format(trip.end)} · ${tn(trip.days, "{n} day", "{n} days")} · ${tn(trip.items.length, "{n} item", "{n} items")}`}
          </Text>
          <Problem>{problem}</Problem>
          {saved ? (
            <Button mode="outlined" icon="albums" onPress={() => router.push({ pathname: "/album/[id]", params: { id: saved.id } })} style={st.button}>{t("Open the album")}</Button>
          ) : demo ? (
            <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant }}>{demoNote()}</Text>
          ) : (
            <>
              <Button mode="contained" icon={busy ? busyIcon : "folderPlus"} onPress={save} disabled={busy || !albums} style={st.button}>{t("Save as album")}</Button>
              <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant }}>{t("Only this phone knows about this trip until you save it. An album is encrypted like the rest.")}</Text>
            </>
          )}
        </View>
      ) : undefined}
      empty={
        <View style={st.empty}>
          <Icon name="map" size={32} color={th.colors.onSurfaceVariant} />
          <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, marginTop: 12, maxWidth: 300 }}>{t("This trip isn't in your library anymore.")}</Text>
        </View>
      }
    />
  );
}

const st = StyleSheet.create({
  top: { paddingHorizontal: space.s1, paddingTop: space.s2, paddingBottom: space.s3, gap: space.s2 },
  button: { alignSelf: "flex-start" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, minHeight: 400 },
});
