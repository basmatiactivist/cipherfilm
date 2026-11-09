// The map tab (docs/MAP.md): photos as clustered thumbnails on a base map. Coordinates are decrypted on the phone and
// thumbnails come from the native pipeline (ThumbView, by item id); the base map's server (OpenFreeMap by default, the
// server's MAP_STYLE) only sees which map tiles are loaded. So the map opens on the whole world and never moves to
// where the photos are by itself.
import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { Appbar, Button, IconButton, Text } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Camera, GeoJSONSource, Layer, Map as MapView, ViewAnnotation, type CameraRef, type ViewAnnotationRef, type GeoJSONSourceRef, type MapRef } from "@maplibre/maplibre-react-native";
import { ThumbView } from "../../modules/cf-native/src/CfNativeModule";
import { NAV_HEIGHT, NavBar } from "../NavBar";
import { Gallery } from "../Gallery";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { areaTitle, coords } from "../places";
import { setViewerList } from "../viewerList";
import { useSession } from "../session";
import { mapCacheReady, mapPrivacyUrl, mapProviderLong, setMapOn, useMapOn } from "../mapConsent";
import { expectAway } from "../autolock";
import { Icon } from "../icons";
import { useAppTheme } from "../ui";
import { text } from "../tokens";
import { t, tn } from "../i18n";
import type { Item } from "../library";

const SOURCE = "cf-photos";
const MAX_ZOOM = 16; // zoomed in this far, a cluster's tap shows its photos instead of zooming further
const MAP_MAX = 19;
const VISIBLE = 0.45; // the share of the map the open panel leaves free, at the top
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
  const [cacheOk, setCacheOk] = useState(false); // an earlier run's map cache is gone before the map shows
  useEffect(() => { if (on) mapCacheReady().then(() => setCacheOk(true)); }, [on]);
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
  const refreshes = useRef(0); // an older refresh that finishes late doesn't overwrite a newer one's markers
  const refresh = async () => {
    const m = map.current, s = src.current;
    if (!m || !s) return;
    const seq = ++refreshes.current;
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
    if (seq === refreshes.current) setMarkers(out);
  };

  // the panel lists the photos in the part of the map it leaves free (the upper VISIBLE share), made again after
  // every zoom or move while it is open; its title says what their places have in common
  const panelOpen = useRef(false);
  const size = useRef({ w: 0, h: 0 });
  const located$ = useRef(located);
  located$.current = located;
  const fillPanel = async () => {
    const m = map.current;
    if (!m || !panelOpen.current || !size.current.w) return;
    const { w, h } = size.current;
    const [nw, se] = await Promise.all([m.unproject([0, 0]), m.unproject([w, h * VISIBLE])]).catch(() => [null, null]);
    if (!nw || !se || !panelOpen.current) return;
    const [w0, north] = nw, [e0, south] = se;
    // the map wraps around: longitudes back into -180…180, and a view wider than the world holds every longitude
    const norm = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
    const all = e0 - w0 >= 360;
    const west = norm(w0), east = norm(e0);
    const inside = (lon: number, lat: number) => lat >= south && lat <= north && (all || (west <= east ? lon >= west && lon <= east : lon >= west || lon <= east));
    const items = located$.current.filter((l) => inside(l.lon, l.lat)).map((l) => l.it).sort((a, b) => (b.meta?.capture_ts ?? 0) - (a.meta?.capture_ts ?? 0));
    setPanel((cur) => ({ items, title: cur?.title ?? "" }));
    areaTitle(items).then((title) => setPanel((cur) => (cur && cur.items === items ? { ...cur, title } : cur)), () => {});
  };
  const refill = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refillSoon = () => { clearTimeout(refill.current); refill.current = setTimeout(() => { fillPanel(); }, 150); };
  const openPanel = () => { panelOpen.current = true; fillPanel(); };
  const closePanel = () => { panelOpen.current = false; setPanel(null); };
  useEffect(() => { refillSoon(); }, [located]);

  // a place moved into the part of the map the panel leaves free: the centre goes below it by a share of the height,
  // measured at the zoom the map ends at (at the current zoom that distance is 2^(zoom change) times smaller)
  const showAbovePanel = async (lngLat: [number, number], zoom?: number) => {
    const m = map.current;
    const { h } = size.current;
    const now = m ? await m.getZoom().catch(() => undefined) : undefined;
    const scale = zoom !== undefined && now !== undefined ? Math.pow(2, zoom - now) : 1;
    const at = m && h ? await m.project(lngLat).catch(() => null) : null;
    const center = m && at ? await m.unproject([at[0], at[1] + (h * (0.5 - VISIBLE / 2)) / scale]).catch(() => null) : null;
    cam.current?.easeTo({ center: center ?? lngLat, ...(zoom !== undefined ? { zoom } : {}), duration: 400 });
  };

  const open = async (mk: Marker) => {
    if (mk.cluster === undefined) {
      // one photo: straight to it in the viewer
      const it = mk.id ? byId.get(mk.id) : undefined;
      if (!it) return;
      setViewerList([it.id]);
      router.push({ pathname: "/photo/[id]", params: { id: it.id, within: "map" } });
      return;
    }
    const s = src.current, m = map.current;
    if (!s || !m) return;
    const zoom = await m.getZoom().catch(() => 0);
    // a marker from before the last move may name a cluster that no longer exists: redraw instead of guessing
    const next = await s.getClusterExpansionZoom(mk.cluster).catch(() => null);
    if (next === null) { refresh(); return; }
    if (next <= MAX_ZOOM && zoom < MAX_ZOOM - 0.5) {
      if (panelOpen.current) showAbovePanel(mk.lngLat, next); else cam.current?.easeTo({ center: mk.lngLat, zoom: next, duration: 400 });
      return;
    }
    // as close as the map goes (or photos at one spot): there, and the photos around it in the panel
    panelOpen.current = true;
    await showAbovePanel(mk.lngLat, zoom < MAX_ZOOM - 0.5 ? MAX_ZOOM : undefined);
    openPanel();
  };

  const inView = openPanel;

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
        <View style={{ flex: 1, marginBottom: NAV_HEIGHT + inset.bottom }}>
          <ScrollView contentContainerStyle={st.consent}>
            <View style={[st.consentIcon, { backgroundColor: th.colors.primaryContainer }]}>
              <Icon name="map" size={28} color={th.colors.onPrimaryContainer} />
            </View>
            <Text variant="headlineSmall" accessibilityRole="header">{t("Show your photos on a map?")}</Text>
            <Text variant="bodyLarge">{t("The map images come from {who}. That service sees this phone's IP address and which areas you look at. When you open a photo's details, a small map of its area is loaded too, so the service can tell roughly where that photo was taken.", { who: mapProviderLong() })}</Text>
            <Text variant="bodyLarge">{t("Your photos, and the list of where they were taken, stay encrypted and are drawn on this phone.")}</Text>
            <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant }}>
              {t("You can turn the map off again under Account › Map.")}{" "}
              <Text accessibilityRole="link" style={{ color: th.colors.primary, fontWeight: "600", textDecorationLine: "underline" }}
                onPress={() => { expectAway(); Linking.openURL(mapPrivacyUrl()); }}>{t("Privacy policy")}</Text>
            </Text>
          </ScrollView>
          {/* the choice sits at the bottom, in reach of the thumb: the yes first and filled, the no as plain text */}
          <View style={[st.actions, { borderTopColor: th.colors.outlineVariant }]}>
            <Button mode="contained" onPress={() => setMapOn(true)} contentStyle={st.actionBtn}>{t("Turn on map")}</Button>
            <Button mode="text" onPress={() => router.replace("/library")} contentStyle={st.actionBtn}>{t("Not now")}</Button>
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, marginBottom: NAV_HEIGHT + inset.bottom }}
          onLayout={(e) => { size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }; }}>
          {cacheOk && (
          <MapView ref={map} style={StyleSheet.absoluteFill} mapStyle={styles[styleAt]} logo={false} compass={false} touchRotate={false} touchPitch={false}
            attribution attributionPosition={{ bottom: 8, right: 8 }}
            onDidFailLoadingMap={() => { if (styleAt + 1 < styles.length) setStyleAt(styleAt + 1); else setFailed(true); }}
            onDidFinishLoadingMap={() => { setFailed(false); refresh(); }}
            // the clusters at the new zoom are only queryable once a frame has been drawn fully after the move
            onRegionDidChange={() => { moved.current = true; refresh(); refillSoon(); }}
            onDidFinishRenderingFrameFully={() => { if (moved.current) { moved.current = false; refresh(); } }}>
            <Camera ref={cam} initialViewState={{ center: WORLD_CENTER, zoom: 0 }} minZoom={0} maxZoom={MAP_MAX} />
            <GeoJSONSource ref={src} id={SOURCE} data={data} cluster clusterRadius={56} clusterMaxZoom={MAP_MAX} maxzoom={MAP_MAX + 1}
              clusterProperties={{ ts: ["max", ["get", "ts"]] }}>
              {/* the markers are native views; this layer only makes the clusters queryable (a radius of 0 or an opacity
                  of 0 would leave it out of queries on Android, so it is one pixel and nearly clear) */}
              <Layer type="circle" id={SOURCE} paint={{ "circle-radius": 1, "circle-opacity": 0.01 }} />
            </GeoJSONSource>
            {markers.map((mk) => (
              <PhotoMarker key={mk.key} mk={mk} thumb={!!mk.cover && !!byId.get(mk.cover)?.has_thumb} onPress={() => open(mk)} />
            ))}
          </MapView>
          )}
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
                <IconButton icon="x" accessibilityLabel={t("Close")} onPress={closePanel} />
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

/** One marker: a round thumbnail, with the count for a cluster. MapLibre draws it as a picture taken when it is laid
 *  out, so it is taken again once the thumbnail shows (else a single photo's marker stays empty). */
function PhotoMarker({ mk, thumb, onPress }: { mk: Marker; thumb: boolean; onPress: () => void }) {
  const th = useAppTheme();
  const ref = useRef<ViewAnnotationRef>(null);
  return (
    <ViewAnnotation ref={ref} id={mk.key} lngLat={mk.lngLat} anchor="center" onPress={onPress}>
      {/* drawn as a picture on the map, so the tap comes from the annotation, not from this view */}
      <View accessibilityLabel={tn(mk.count, "{n} photo", "{n} photos")}
        style={[st.marker, { borderColor: th.colors.surface, backgroundColor: th.colors.primaryContainer }]}>
        {thumb && mk.cover ? <ThumbView item={mk.cover} software style={st.thumb} onShown={() => ref.current?.refresh()} /> : null}
        {mk.count > 1 && (
          <View style={[st.count, { backgroundColor: th.colors.primary, borderColor: th.colors.surface }]}>
            <Text style={{ color: th.colors.onPrimary, fontSize: 12, fontWeight: "700" }}>{mk.count > 999 ? `${Math.floor(mk.count / 1000)}k` : mk.count}</Text>
          </View>
        )}
      </View>
    </ViewAnnotation>
  );
}

const st = StyleSheet.create({
  consent: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24, gap: 16 },
  consentIcon: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  actions: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 12, gap: 4, borderTopWidth: StyleSheet.hairlineWidth },
  actionBtn: { height: 48 },
  marker: { width: 52, height: 52, borderRadius: 26, borderWidth: 3, overflow: "visible", elevation: 4 },
  thumb: { width: 46, height: 46, borderRadius: 23, overflow: "hidden" },
  count: { position: "absolute", top: -6, right: -8, minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  bar: { position: "absolute", top: 12, left: 12, right: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingLeft: 12, paddingRight: 4, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  fail: { position: "absolute", top: 72, left: 12, right: 12, padding: 12, borderRadius: 12 },
  panel: { position: "absolute", left: 0, right: 0, bottom: 0, height: `${Math.round((1 - VISIBLE) * 100)}%`, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, overflow: "hidden" },
  panelHead: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingTop: 8 },
});
