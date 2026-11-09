// The map tab (docs/MAP.md): photos as clustered thumbnails on a base map. Coordinates are decrypted on the phone and
// thumbnails come from the native pipeline (ThumbView, by item id); the base map's server (OpenFreeMap by default, the
// server's MAP_STYLE) only sees which map tiles are loaded. So the map opens on the whole world and never moves to
// where the photos are by itself.
import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, StyleSheet, useColorScheme, View } from "react-native";
import { Appbar, Button, IconButton, Text } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Camera, GeoJSONSource, Layer, Map as MapView, ViewAnnotation, type CameraRef, type GeoJSONSourceRef, type MapRef } from "@maplibre/maplibre-react-native";
import { ThumbView } from "../../modules/cf-native/src/CfNativeModule";
import { NAV_HEIGHT, NavBar } from "../NavBar";
import { Gallery } from "../Gallery";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { coords, placeName } from "../places";
import { useSession } from "../session";
import { mapPrivacyUrl, mapProviderLong, setMapOn, useMapOn } from "../mapConsent";
import { expectAway } from "../autolock";
import { Icon } from "../icons";
import { useAppTheme } from "../ui";
import { text } from "../tokens";
import { t, tn } from "../i18n";
import type { Item } from "../library";

const SOURCE = "cf-photos";
const MAX_ZOOM = 16; // zoomed in this far, a cluster's tap shows its photos instead of zooming further
const MAP_MAX = 19;
const MAX_MARKERS = 80;
// the whole world, the same for everyone: never where the photos are (zoom 0 fits it on a phone in portrait)
const WORLD_CENTER: [number, number] = [10, 25];

type Marker = { key: string; lngLat: [number, number]; count: number; cluster?: number; id?: string; cover?: string };

export default function MapScreen() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const scheme = useColorScheme();
  const conf = useSession().me?.map;
  const on = useMapOn();
  const { items } = useLibrary();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  const located = useMemo(() => (items ?? []).flatMap((it) => { const c = coords(it); return c ? [{ it, ...c }] : []; }), [items]);
  const byId = useMemo(() => new Map(located.map((l) => [l.it.id, l.it])), [located]);
  const data = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: located.map((l) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [l.lon, l.lat] }, properties: { id: l.it.id, ts: l.it.meta?.capture_ts ?? l.it.created_at * 1000 } })),
  }), [located]);

  const styles = conf ? (scheme === "dark" || th.dark ? conf.dark : conf.light) : [];
  const [styleAt, setStyleAt] = useState(0);
  useEffect(() => setStyleAt(0), [styles[0]]);
  const [failed, setFailed] = useState(false);
  const map = useRef<MapRef>(null);
  const cam = useRef<CameraRef>(null);
  const src = useRef<GeoJSONSourceRef>(null);
  const moved = useRef(false);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [panel, setPanel] = useState<{ items: Item[]; title: string } | null>(null);

  // the clusters on screen as thumbnail markers, after every move
  const refresh = async () => {
    const m = map.current, s = src.current;
    if (!m || !s) return;
    const feats = await m.queryRenderedFeatures({ layers: [SOURCE] }).catch(() => []);
    const seen = new Set<string>();
    const out: Marker[] = [];
    for (const f of feats) {
      const p = (f.properties ?? {}) as { cluster?: boolean; cluster_id?: number; point_count?: number; id?: string };
      const key = p.cluster ? `c${p.cluster_id}` : `p${p.id}`;
      if (seen.has(key) || out.length >= MAX_MARKERS) continue;
      seen.add(key);
      const [lon, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
      out.push({ key, lngLat: [lon, lat], count: p.cluster ? p.point_count ?? 1 : 1, cluster: p.cluster ? p.cluster_id : undefined, id: p.id, cover: p.cluster ? undefined : p.id });
    }
    // a cluster's cover: the newest of its first photos
    await Promise.all(out.filter((x) => x.cluster !== undefined).map(async (x) => {
      const leaves = await s.getClusterLeaves(x.cluster!, 30, 0).catch(() => null);
      const ps = (leaves ?? []).map((l) => l.properties as { id: string; ts: number }).sort((a, b) => b.ts - a.ts);
      x.cover = ps[0]?.id;
    }));
    setMarkers(out);
  };

  const showPanel = (list: Item[], fallback: string) => {
    const sorted = [...list].sort((a, b) => (b.meta?.capture_ts ?? 0) - (a.meta?.capture_ts ?? 0));
    setPanel({ items: sorted, title: fallback });
    placeName(sorted[0]).then((n) => n && setPanel((cur) => (cur && cur.items === sorted ? { ...cur, title: n } : cur)), () => {});
  };

  const open = async (mk: Marker) => {
    if (mk.cluster === undefined) {
      const it = mk.id ? byId.get(mk.id) : undefined;
      if (it) showPanel([it], t("1 photo"));
      return;
    }
    const s = src.current, m = map.current;
    if (!s || !m) return;
    const zoom = await m.getZoom().catch(() => 0);
    // a marker from before the last move may name a cluster that no longer exists: redraw instead of guessing
    const next = await s.getClusterExpansionZoom(mk.cluster).catch(() => null);
    if (next === null) { refresh(); return; }
    if (next <= MAX_ZOOM && zoom < MAX_ZOOM - 0.5) { cam.current?.easeTo({ center: mk.lngLat, zoom: next, duration: 400 }); return; }
    const leaves = await s.getClusterLeaves(mk.cluster, 10000, 0).catch(() => null);
    const list = (leaves ?? []).map((l) => byId.get((l.properties as { id: string }).id)).filter((x): x is Item => !!x);
    showPanel(list, tn(list.length, "{n} photo", "{n} photos"));
  };

  const inView = async () => {
    const b = await map.current?.getBounds().catch(() => null);
    if (!b) return;
    const [w, s, e, n] = b;
    const inside = (lon: number, lat: number) => lat >= s && lat <= n && (w <= e ? lon >= w && lon <= e : lon >= w || lon <= e);
    showPanel(located.filter((l) => inside(l.lon, l.lat)).map((l) => l.it), t("This area"));
  };

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Content title={t("Map")} titleStyle={text.page} />
        <Appbar.Action icon="user" accessibilityLabel={t("Account")} onPress={() => router.push("/account")} />
      </Appbar.Header>
      {!conf ? (
        <Text style={{ padding: 16, color: th.colors.onSurfaceVariant }}>{t("The map is turned off on this server.")}</Text>
      ) : !on ? (
        // before the yes nothing is loaded from the map's server (docs/MAP.md)
        <View style={[st.consent, { backgroundColor: th.colors.surface, borderColor: th.colors.outlineVariant }]}>
          <Icon name="map" size={28} color={th.colors.primary} />
          <Text variant="titleLarge">{t("Show your photos on a map?")}</Text>
          <Text variant="bodyMedium">{t("The map images come from {who}. That service sees this phone's IP address and which areas you look at. When you open a photo's details, a small map of its area is loaded too, so the service can tell roughly where that photo was taken.", { who: mapProviderLong() })}</Text>
          <Text variant="bodyMedium">{t("Your photos, and the list of where they were taken, stay encrypted and are drawn on this phone.")}</Text>
          <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant }}>{t("You can turn the map off again under Account › Map.")}</Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button mode="contained" onPress={() => setMapOn(true)}>{t("Turn on map")}</Button>
            <Button mode="outlined" onPress={() => router.replace("/library")}>{t("Not now")}</Button>
            <Button mode="text" onPress={() => { expectAway(); Linking.openURL(mapPrivacyUrl()); }}>{t("Privacy policy")}</Button>
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, marginBottom: NAV_HEIGHT + inset.bottom }}>
          <MapView ref={map} style={StyleSheet.absoluteFill} mapStyle={styles[styleAt]} logo={false} compass={false} touchRotate={false} touchPitch={false}
            attribution attributionPosition={{ bottom: 8, right: 8 }}
            onDidFailLoadingMap={() => { if (styleAt + 1 < styles.length) setStyleAt(styleAt + 1); else setFailed(true); }}
            onDidFinishLoadingMap={() => { setFailed(false); refresh(); }}
            // the clusters at the new zoom are only queryable once a frame has been drawn fully after the move
            onRegionDidChange={() => { moved.current = true; refresh(); }}
            onDidFinishRenderingFrameFully={() => { if (moved.current) { moved.current = false; refresh(); } }}>
            <Camera ref={cam} initialViewState={{ center: WORLD_CENTER, zoom: 0 }} minZoom={0} maxZoom={MAP_MAX} />
            <GeoJSONSource ref={src} id={SOURCE} data={data} cluster clusterRadius={56} clusterMaxZoom={MAP_MAX} maxzoom={MAP_MAX + 1}
              clusterProperties={{ ts: ["max", ["get", "ts"]] }}>
              {/* the markers are native views; this layer only makes the clusters queryable (a radius of 0 or an opacity
                  of 0 would leave it out of queries on Android, so it is one pixel and nearly clear) */}
              <Layer type="circle" id={SOURCE} paint={{ "circle-radius": 1, "circle-opacity": 0.01 }} />
            </GeoJSONSource>
            {markers.map((mk) => (
              <ViewAnnotation key={mk.key} id={mk.key} lngLat={mk.lngLat} anchor="center" onPress={() => open(mk)}>
                {/* drawn as a picture on the map, so the tap comes from the annotation, not from this view */}
                <View accessibilityLabel={tn(mk.count, "{n} photo", "{n} photos")}
                  style={[st.marker, { borderColor: th.colors.surface, backgroundColor: th.colors.primaryContainer }]}>
                  {mk.cover && byId.get(mk.cover)?.has_thumb ? <ThumbView item={mk.cover} software style={st.thumb} /> : null}
                  {mk.count > 1 && (
                    <View style={[st.count, { backgroundColor: th.colors.primary, borderColor: th.colors.surface }]}>
                      <Text style={{ color: th.colors.onPrimary, fontSize: 12, fontWeight: "700" }}>{mk.count > 999 ? `${Math.floor(mk.count / 1000)}k` : mk.count}</Text>
                    </View>
                  )}
                </View>
              </ViewAnnotation>
            ))}
          </MapView>
          <View style={[st.bar, { backgroundColor: th.colors.surface, borderColor: th.colors.outlineVariant }]}>
            <Text variant="labelLarge">{located.length === 0 ? t("No photos with a location yet") : tn(located.length, "{n} photo on the map", "{n} photos on the map")}</Text>
            {located.length > 0 && <Button compact mode="contained-tonal" onPress={inView}>{t("Photos in this area")}</Button>}
          </View>
          {failed && <Text style={[st.fail, { backgroundColor: th.colors.errorContainer, color: th.colors.onErrorContainer }]}>{t("The map couldn't be loaded. Check the connection and try again later.")}</Text>}
          {panel && (
            <View style={[st.panel, { backgroundColor: th.colors.background, borderColor: th.colors.outlineVariant }]}>
              <View style={st.panelHead}>
                <View style={{ flex: 1 }}>
                  <Text variant="titleMedium" numberOfLines={1}>{panel.title}</Text>
                  <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant }}>{tn(panel.items.length, "{n} photo", "{n} photos")}</Text>
                </View>
                <IconButton icon="x" accessibilityLabel={t("Close")} onPress={() => setPanel(null)} />
              </View>
              <Gallery items={panel.items} error={undefined} loading={false} onRefresh={() => {}} header={null} empty={null} flat within="map" />
            </View>
          )}
        </View>
      )}
      <NavBar current="map" />
    </View>
  );
}

const st = StyleSheet.create({
  consent: { margin: 16, padding: 20, gap: 12, borderRadius: 16, borderWidth: 1 },
  marker: { width: 52, height: 52, borderRadius: 26, borderWidth: 3, overflow: "visible", elevation: 4 },
  thumb: { width: 46, height: 46, borderRadius: 23, overflow: "hidden" },
  count: { position: "absolute", top: -6, right: -8, minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  bar: { position: "absolute", top: 12, left: 12, right: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingLeft: 12, paddingRight: 4, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  fail: { position: "absolute", top: 72, left: 12, right: 12, padding: 12, borderRadius: 12 },
  panel: { position: "absolute", left: 0, right: 0, bottom: 0, height: "55%", borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, overflow: "hidden" },
  panelHead: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingTop: 8 },
});
