// The Mac app's map (docs/MAP.md), the web app's map (web/src/map/ui.tsx) in a web view of its own: photo locations
// come from the app (MapPage.swift), which decrypted them; they stay in this page. The base map's server (the styles
// the Cipherfilm server names) only sees which tiles are loaded: the map opens on the whole world and never moves to
// the photos by itself. No cookies (a data store of its own, kept in memory) and no referrer go with those requests.
//   body.map: the map tab, clustered round thumbnails; body.mini: a photo's spot in its details, with a pin.
import { Map as MapLibre, Marker, NavigationControl, setWorkerUrl } from "./maplibre-gl.mjs";

const app = window.webkit.messageHandlers.cf;
const post = (m) => app.postMessage(m);
addEventListener("error", (e) => post({ t: "log", s: `error: ${e.message}` }));
addEventListener("unhandledrejection", (e) => post({ t: "log", s: `rejection: ${e.reason}` }));
document.addEventListener("securitypolicyviolation", (e) => post({ t: "log", s: `blocked by the CSP: ${e.violatedDirective} ${e.blockedURI}` }));

// the worker from a blob of its own bytes: it then has this page's CSP, so it reaches only the base map's hosts
const workerSrc = await (await fetch("maplibre-gl-worker.mjs")).text();
setWorkerUrl(URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" })));

const SOURCE = "cf-photos";
const MAX_ZOOM = 16; // zoomed in this far, a cluster's click shows its photos instead of zooming further
const MAP_MAX = 19; // photos at one spot stay one cluster up to here
const MAX_MARKERS = 120; // thumbnails drawn at once
// the whole world, the same for everyone: never where the photos are
const WORLD_BOUNDS = [[-165, -50], [175, 70]];

const conf = await post({ t: "config" });
let dark = conf.dark;
document.body.classList.toggle("dark", dark);
const styles = () => (dark ? conf.styles.dark : conf.styles.light);
const mini = conf.mode === "mini";

// the web view starts without a size: a map made then fits the world into nothing and its clusters land in the wrong
// places, so it waits until the page has its size
await new Promise((ok) => {
  const el = document.getElementById("map");
  const sized = () => el.clientWidth > 0 && el.clientHeight > 0;
  if (sized()) { ok(); return; }
  const ro = new ResizeObserver(() => { if (sized()) { ro.disconnect(); ok(); } });
  ro.observe(el);
});

let tried = 0;
let loaded = false;
const m = new MapLibre(mini
  ? { container: "map", style: styles()[0], center: [conf.lon, conf.lat], zoom: 11, interactive: false, attributionControl: { compact: true } }
  : { container: "map", style: styles()[0], center: [10, 15], zoom: 1, minZoom: 0.5, maxZoom: MAP_MAX, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false });
if (!mini) {
  m.touchZoomRotate.disableRotation();
  m.keyboard.disableRotation();
  m.fitBounds(WORLD_BOUNDS, { padding: 8, animate: false });
  m.addControl(new NavigationControl({ showCompass: false }), "top-right");
}

// a style that doesn't load (the provider is down): the next one in the list
m.on("error", (e) => {
  if (loaded) return;
  post({ t: "log", s: `style ${tried}: ${e.error?.message ?? e.error ?? "error"}` });
  if (tried + 1 < styles().length) { tried++; m.setStyle(styles()[tried]); } else post({ t: "failed" });
});

const setStyle = () => { tried = 0; loaded = false; m.setStyle(styles()[0]); };

window.cf = {
  /** The app's appearance changed: the other base map. */
  setDark(d) {
    if (d === dark) return;
    dark = d;
    document.body.classList.toggle("dark", dark);
    clearMarkers();
    setStyle();
  },
};

// ---- the small map: the photo's spot with a pin ----
if (mini) {
  const pinEl = document.createElement("div");
  pinEl.className = "mappin";
  const pin = new Marker({ element: pinEl }).setLngLat([conf.lon, conf.lat]).addTo(m);
  // the attribution starts folded (its ⓘ opens it): in a map this small it would cover half of it. MapLibre opens it
  // again when the style's sources arrive, so it is folded once more when the map is first drawn completely
  const fold = () => document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  m.on("style.load", () => { loaded = true; fold(); post({ t: "styleLoaded" }); });
  m.once("idle", fold);
  window.cf.center = (lat, lon) => { pin.setLngLat([lon, lat]); m.jumpTo({ center: [lon, lat], zoom: 11 }); m.once("idle", fold); };
}

// ---- the map tab: clustered photos ----
let points = mini ? [] : conf.points;
const geojson = () => ({
  type: "FeatureCollection",
  features: points.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { id: p.id, ts: p.ts } })),
});

// while the panel is open, it gets the photos in view after every zoom or move (at the module's top level: the map's
// events and the markers' clicks call these)
let following = false, areaTimer;
function sendArea() { if (following && window.cf?.inView) post({ t: "area", ids: window.cf.inView() }); }
function areaSoon() { clearTimeout(areaTimer); areaTimer = setTimeout(sendArea, 150); }

const markers = new Map(); // key -> { marker, img, cover }
const thumbs = new Map(); // id -> data URL (a few hundred small JPEGs at most)
function clearMarkers() { for (const x of markers.values()) x.marker.remove(); markers.clear(); }

async function setCover(k, id) {
  const x = markers.get(k);
  if (!x || !id || x.cover === id) return;
  x.cover = id;
  let u = thumbs.get(id);
  if (!u) {
    try { u = await post({ t: "thumb", id }); } catch { u = null; }
    if (u) thumbs.set(id, u);
  }
  if (u && markers.get(k) === x && x.cover === id) x.img.src = u;
}

function markerEl(count, onClick) {
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

let pending = false;
function draw() {
  pending = false;
  const src = m.getSource(SOURCE);
  if (!src || !m.isSourceLoaded(SOURCE)) return;
  const seen = new Set();
  for (const f of m.queryRenderedFeatures({ layers: [SOURCE] }).slice(0, MAX_MARKERS)) {
    const props = f.properties;
    const k = props.cluster ? `c${props.cluster_id}` : `p${props.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (markers.has(k)) continue;
    const [lon, lat] = f.geometry.coordinates;
    const count = props.cluster ? props.point_count ?? 1 : 1;
    const open = async () => {
      if (!props.cluster) { post({ t: "open", id: props.id }); return; }
      const z = await src.getClusterExpansionZoom(props.cluster_id);
      const far = m.getZoom() < MAX_ZOOM - 0.5;
      if (z <= MAX_ZOOM && far) { m.easeTo({ center: [lon, lat], zoom: Math.min(z, MAX_ZOOM) }); return; }
      // as close as the map goes (or photos at one spot): there, and the panel beside the map opens with the photos
      // around it and follows the map
      following = true;
      m.easeTo({ center: [lon, lat], ...(far ? { zoom: MAX_ZOOM } : {}) });
      areaSoon();
    };
    const { el, img } = markerEl(count, open);
    markers.set(k, { marker: new Marker({ element: el }).setLngLat([lon, lat]).addTo(m), img });
    if (props.cluster) {
      // the newest of the first ones as the cover
      src.getClusterLeaves(props.cluster_id, 50, 0).then((ls) => {
        const ids = ls.map((l) => l.properties).sort((a, b) => b.ts - a.ts);
        setCover(k, ids[0]?.id);
      }, () => {});
    } else setCover(k, props.id);
  }
  for (const [k, x] of [...markers]) if (!seen.has(k)) { x.marker.remove(); markers.delete(k); }
  post({ t: "markers", n: markers.size });
}
const later = () => { if (!pending) { pending = true; requestAnimationFrame(draw); } };

if (!mini) {
  m.on("style.load", () => {
    loaded = true;
    if (!m.getSource(SOURCE)) {
      m.addSource(SOURCE, { type: "geojson", data: geojson(), cluster: true, maxzoom: MAP_MAX + 1, clusterMaxZoom: MAP_MAX, clusterRadius: 56, clusterProperties: { ts: ["max", ["get", "ts"]] } });
      // invisible: the markers are HTML; the layer makes the clusters queryable
      m.addLayer({ id: SOURCE, type: "circle", source: SOURCE, paint: { "circle-radius": 0, "circle-opacity": 0 } });
    }
    post({ t: "styleLoaded" });
    later();
  });
  m.on("sourcedata", (e) => { if (e.sourceId === SOURCE) later(); });
  m.on("moveend", () => { later(); areaSoon(); });
  m.on("resize", areaSoon); // the panel opening makes the map narrower: a different area is on screen
  m.on("idle", later);
  m.on("zoomend", () => { clearMarkers(); later(); }); // clusters change their ids

  /** New or removed photos: the data again, without touching the view. */
  window.cf.setPoints = (p) => { points = p; clearMarkers(); m.getSource(SOURCE)?.setData(geojson()); areaSoon(); };
  /** The photos inside what the map shows now ("Photos in this area"). */
  window.cf.inView = () => {
    const b = m.getBounds();
    return points.filter((p) => b.contains([p.lon, p.lat])).map((p) => p.id);
  };
  window.cf.follow = (on) => { following = on; if (on) sendArea(); };
  window.cf.markers = () => markers.size;
}
