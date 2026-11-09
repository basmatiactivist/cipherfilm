// The map tab (docs/MAP.md): photos as clustered thumbnails on a base map. Coordinates and thumbnails are decrypted
// on this device and drawn here; the base map's server (OpenFreeMap by default, the server's MAP_STYLE) only sees which
// map tiles are loaded. So the map opens on the whole world and never jumps to where the photos are by itself: only
// what the person zooms into is asked for. No cookies or referrer go with those requests (the server's
// Referrer-Policy; MapLibre's requests are "same-origin", so this server's cookies never go to another host).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Map as MapLibre, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource, type LngLatLike, type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Icon } from "../icons";
import { mem } from "../state";
import { dropImage, thumbUrl, wantImage } from "../cache";
import { Timeline } from "../grid";
import type { Item } from "../items";
import { located, placeName, type Located } from "./locations";
import { mapProviderLong, PRIVACY_URL, setMapOn, useMapOn } from "./consent";

setWorkerUrl(workerUrl);

type Point = { type: "Point"; coordinates: [number, number] };
type Collection = { type: "FeatureCollection"; features: { type: "Feature"; geometry: Point; properties: { id: string; ts: number } }[] };

const SOURCE = "cf-photos";
const MAX_ZOOM = 16; // zoomed in this far, a cluster's click shows its photos instead of zooming further
const MAP_MAX = 19; // photos at one spot stay one cluster up to here (the source clusters to MAP_MAX)
const MAX_MARKERS = 120; // thumbnails drawn at once; beyond that the map shows fewer, larger clusters
// the whole world, the same for everyone: never where the photos are (docs/MAP.md)
const WORLD_BOUNDS: [[number, number], [number, number]] = [[-165, -50], [175, 70]];
const WORLD: LngLatLike = [10, 15];

const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

function geojson(points: Located[]): Collection {
  return {
    type: "FeatureCollection",
    features: points.map((l) => ({ type: "Feature", geometry: { type: "Point", coordinates: [l.lon, l.lat] }, properties: { id: l.item.id, ts: l.item.meta?.capture_ts ?? l.item.created_at * 1000 } })),
  };
}

/** A round thumbnail with a count: the newest photo of the cluster on top. */
function markerEl(count: number, onClick: () => void): { el: HTMLElement; img: HTMLImageElement } {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "mapmarker";
  el.setAttribute("aria-label", count === 1 ? "1 photo" : `${count} photos`);
  const img = document.createElement("img");
  img.alt = "";
  el.append(img);
  if (count > 1) {
    const b = document.createElement("span");
    b.className = "mapcount";
    b.textContent = count > 999 ? `${Math.floor(count / 1000)}k` : String(count);
    el.append(b);
  }
  el.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return { el, img };
}

/** Before the first map: what turning it on means, and the button. */
function MapConsent(p: { onLater: () => void }) {
  const who = mapProviderLong();
  return (
    <section class="panel mapconsent" aria-labelledby="mapconsent-h">
      <span class="accicon"><Icon name="map" size={22} /></span>
      <h2 id="mapconsent-h">Show your photos on a map?</h2>
      <p>The map images come from {who}. That service sees this device's IP address and which areas you look at. When you open a photo's details, a small map of its area is loaded too, so the service can tell roughly where that photo was taken.</p>
      <p>Your photos, and the list of where they were taken, stay encrypted and are drawn in this browser.</p>
      <p class="small"><a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy policy</a> · You can turn the map off again under Account › Map.</p>
      <div class="row">
        <button class="btn" onClick={() => setMapOn(true)}>Turn on map</button>
        <button class="btn secondary" onClick={p.onLater}>Not now</button>
      </div>
    </section>
  );
}

export function MapPage(p: { items: Item[]; onOpen: (list: Item[], index: number) => void; onLater: () => void }) {
  const on = useMapOn();
  if (!mem.me?.map) return <p class="hint">The map is turned off on this server.</p>;
  if (!on) return <MapConsent onLater={p.onLater} />;
  return <MapView {...p} />;
}

function MapView(p: { items: Item[]; onOpen: (list: Item[], index: number) => void }) {
  const conf = mem.me?.map;
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const points = useMemo(() => located(p.items), [p.items]);
  const byId = useMemo(() => new globalThis.Map(points.map((l) => [l.item.id, l.item])), [points]);
  const [panel, setPanel] = useState<{ items: Item[]; title: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const itemsRef = useRef(byId);
  itemsRef.current = byId;
  const dataRef = useRef(points);
  dataRef.current = points;

  // the panel's title: the place of its newest photo
  const showPanel = (items: Item[], fallback: string) => {
    const sorted = [...items].sort((a, b) => (b.meta?.capture_ts ?? 0) - (a.meta?.capture_ts ?? 0));
    setPanel({ items: sorted, title: fallback });
    placeName(sorted[0]).then((n) => n && setPanel((cur) => (cur && cur.items === sorted ? { ...cur, title: n } : cur)));
  };

  useEffect(() => {
    if (!conf || !box.current) return;
    let styles = dark() ? conf.dark : conf.light;
    let tried = 0;
    const m = new MapLibre({
      container: box.current, style: styles[0], center: WORLD, zoom: 1, minZoom: 0.5, maxZoom: MAP_MAX,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    });
    m.touchZoomRotate.disableRotation();
    m.fitBounds(WORLD_BOUNDS, { padding: 8, animate: false });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.current = m;

    // a style that doesn't load (the provider is down): the next one in the list
    let loaded = false;
    m.on("error", () => {
      if (loaded) return;
      if (tried + 1 < styles.length) { tried++; m.setStyle(styles[tried]); } else setFailed(true);
    });

    const markers = new globalThis.Map<string, { marker: Marker; img: HTMLImageElement; cover?: string }>();
    const drop = (k: string) => {
      const x = markers.get(k);
      if (!x) return;
      x.marker.remove();
      if (x.cover) dropImage("thumb", x.cover);
      markers.delete(k);
    };
    const setCover = async (k: string, id: string | undefined) => {
      const x = markers.get(k);
      const it = id ? itemsRef.current.get(id) : undefined;
      if (!x || !it || x.cover === id) return;
      if (x.cover) dropImage("thumb", x.cover);
      x.cover = id;
      wantImage("thumb", id!);
      try { const u = await thumbUrl(it); if (markers.get(k) === x && x.cover === id) x.img.src = u; } catch { /* the tile stays plain */ }
    };

    const addSource = () => {
      if (m.getSource(SOURCE)) return;
      m.addSource(SOURCE, {
        type: "geojson", data: geojson(dataRef.current) as never, cluster: true, maxzoom: MAP_MAX + 1, clusterMaxZoom: MAP_MAX, clusterRadius: 56,
        clusterProperties: { ts: ["max", ["get", "ts"]] },
      });
      // invisible: the markers are HTML; the layer makes the clusters queryable
      m.addLayer({ id: SOURCE, type: "circle", source: SOURCE, paint: { "circle-radius": 0, "circle-opacity": 0 } });
    };

    let pending = false;
    const draw = () => {
      pending = false;
      if (!m.getSource(SOURCE) || !m.isSourceLoaded(SOURCE)) return;
      const src = m.getSource(SOURCE) as GeoJSONSource;
      const seen = new Set<string>();
      const feats = m.queryRenderedFeatures({ layers: [SOURCE] }).slice(0, MAX_MARKERS) as MapGeoJSONFeature[];
      for (const f of feats) {
        const props = f.properties as { cluster?: boolean; cluster_id?: number; point_count?: number; id?: string };
        const k = props.cluster ? `c${props.cluster_id}` : `p${props.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (markers.has(k)) continue;
        const [lon, lat] = (f.geometry as unknown as Point).coordinates;
        const count = props.cluster ? props.point_count ?? 1 : 1;
        const open = async () => {
          if (props.cluster) {
            const z = await src.getClusterExpansionZoom(props.cluster_id!);
            if (z <= MAX_ZOOM && m.getZoom() < MAX_ZOOM - 0.5) { m.easeTo({ center: [lon, lat], zoom: Math.min(z, MAX_ZOOM) }); return; }
            const leaves = await src.getClusterLeaves(props.cluster_id!, Infinity, 0);
            showPanel(leaves.map((l) => itemsRef.current.get((l.properties as { id: string }).id)).filter((x): x is Item => !!x), `${count} photos`);
          } else {
            const it = itemsRef.current.get(props.id!);
            if (it) p.onOpen([it], 0);
          }
        };
        const { el, img } = markerEl(count, open);
        const marker = new Marker({ element: el }).setLngLat([lon, lat]).addTo(m);
        markers.set(k, { marker, img });
        if (props.cluster) {
          src.getClusterLeaves(props.cluster_id!, 50, 0).then((ls) => {
            // the newest of the first ones as the cover
            const ids = ls.map((l) => l.properties as { id: string; ts: number }).sort((a, b) => b.ts - a.ts);
            setCover(k, ids[0]?.id);
          }, () => {});
        } else setCover(k, props.id);
      }
      for (const k of [...markers.keys()]) if (!seen.has(k)) drop(k);
    };
    const later = () => { if (!pending) { pending = true; requestAnimationFrame(draw); } };

    m.on("style.load", () => { loaded = true; addSource(); later(); });
    m.on("sourcedata", (e: { sourceId?: string }) => { if (e.sourceId === SOURCE) later(); });
    m.on("moveend", later);
    m.on("zoomend", () => { for (const k of [...markers.keys()]) drop(k); later(); }); // clusters change their ids

    // the system's dark mode changes: the other base map
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => { styles = mq.matches ? conf.dark : conf.light; tried = 0; loaded = false; for (const k of [...markers.keys()]) drop(k); m.setStyle(styles[0]); };
    mq.addEventListener("change", onScheme);
    return () => {
      mq.removeEventListener("change", onScheme);
      for (const k of [...markers.keys()]) drop(k);
      m.remove();
      map.current = null;
    };
  }, [conf]);

  // new or removed photos: the data again, without touching the view
  useEffect(() => {
    const src = map.current?.getSource(SOURCE) as GeoJSONSource | undefined;
    src?.setData(geojson(points) as never);
  }, [points]);

  const inView = () => {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds();
    showPanel(points.filter((l) => b.contains([l.lon, l.lat])).map((l) => l.item), "This area");
  };

  if (!conf) return <p class="hint">The map is turned off on this server.</p>;
  return (
    <div class={`mappage${panel ? " withpanel" : ""}`}>
      <div class="mapwrap">
        <div ref={box} class="mapbox" aria-label="Map of your photos" role="region" />
        {failed && <p class="error mapfail" role="alert">The map couldn't be loaded. Check the connection and try again later.</p>}
        <div class="mapbar">
          <span>{points.length === 0 ? "No photos with a location yet" : points.length === 1 ? "1 photo on the map" : `${points.length} photos on the map`}</span>
          {points.length > 0 && <button class="btn small" onClick={inView}><Icon name="photos" size={16} />Photos in this area</button>}
        </div>
      </div>
      {panel && (
        <aside class="mappanel" aria-label={panel.title}>
          <div class="mappanelhead">
            <h2 dir="auto">{panel.title}</h2>
            <span class="muted small">{panel.items.length === 1 ? "1 photo" : `${panel.items.length} photos`}</span>
            <button class="iconbtn" aria-label="Close" onClick={() => setPanel(null)}><Icon name="x" /></button>
          </div>
          {panel.items.length === 0
            ? <p class="hint">No photos in this area.</p>
            : <Timeline items={panel.items} flat selectMode={false} selected={new Set()} onToggle={() => {}} onOpen={(id) => p.onOpen(panel.items, panel.items.findIndex((i) => i.id === id))} />}
        </aside>
      )}
    </div>
  );
}

/** The small map in a photo's details: its spot at district level (not street level), only when the details are
 *  opened, so the base map's server learns the area of exactly the photos whose details someone looks at. */
export function MiniMap(p: { lat: number; lon: number }) {
  const on = useMapOn();
  const conf = on ? mem.me?.map : undefined; // nothing is loaded before the person turned the map on
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!conf || !box.current) return;
    const styles = dark() ? conf.dark : conf.light;
    let tried = 0, loaded = false;
    const m = new MapLibre({
      container: box.current, style: styles[0], center: [p.lon, p.lat], zoom: 11, minZoom: 3, maxZoom: 14,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    });
    m.touchZoomRotate.disableRotation();
    // the attribution starts folded (its ⓘ opens it): in a map this small it would cover half of it
    m.on("style.load", () => { loaded = true; box.current?.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"); });
    m.on("error", () => { if (!loaded && tried + 1 < styles.length) { tried++; m.setStyle(styles[tried]); } });
    const pin = document.createElement("span");
    pin.className = "mappin";
    new Marker({ element: pin }).setLngLat([p.lon, p.lat]).addTo(m);
    return () => m.remove();
  }, [conf, p.lat, p.lon]);
  if (!conf) return null;
  return <div ref={box} class="minimap" role="img" aria-label="Where this photo was taken" />;
}
