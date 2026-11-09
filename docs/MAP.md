# The map

The Map tab shows photos where they were taken, as clustered thumbnails on a world map, in the web, Android and Mac
apps. A photo's details show the place's name and a small map of its spot. Search finds photos by place: "zurich",
"Zürich", "switzerland", "new york".

## What stays on the device

- **Coordinates.** A photo's location is part of its encrypted metadata (`gps` in `meta_enc`, docs/CRYPTO.md), written by
  the app or tool that uploaded it. The server stores it encrypted and never sees it. The apps decrypt it with the rest of
  the metadata and draw and cluster the photos on the device.
- **Thumbnails.** The markers show the photos' thumbnails, decrypted on the device like in the timeline.
- **Place names.** They come from a file bundled with the apps, `web/src/places/places-v1.bin` (every place with at least
  1,000 inhabitants, with its region and country, from GeoNames), and are looked up on the device: the nearest place
  within 50 km, else only the country (within 300 km), at sea nothing. No coordinates are sent anywhere to name them.
  `scripts/places.mjs` builds the file; it is the same for everyone, so it says nothing about anyone's photos.
- **Search by place** works over those names, on the device, like the rest of search (docs/SEARCH.md).

## What the map's server sees

The base map (streets, borders, labels) comes from a tile server: by default OpenFreeMap, with VersaTiles as a fallback
when OpenFreeMap doesn't answer. A device asks it for the map images (tiles) of the area on screen. So the tile server
sees the device's IP address and which areas and zoom levels are looked at, never a photo, its coordinates, its
thumbnail or anything else from the library. To keep that small:

- The map opens on the whole world and never moves to where the photos are by itself; only what the person zooms or
  moves to is loaded.
- A photo's small map in its details loads only when the details are opened, at district level (zoom 11), not street
  level. Looking at a photo's details tells the tile server roughly where that one photo was taken.
- No cookies and no referrer go to the tile server (the web app's `Referrer-Policy: no-referrer`; MapLibre's requests
  carry this server's cookies only to this server).
- OpenFreeMap: no account, no API key, no cookies; IP addresses are not in its access logs, error logs are deleted after
  7 days ([privacy](https://openfreemap.org/privacy/)). It may serve through Cloudflare. VersaTiles: no key, "does not
  track your users".

## Settings

`MAP_STYLE` on the server (docs/SELF-HOSTING.md):

| Value | Effect |
|---|---|
| empty (default) | OpenFreeMap (light: `positron`, dark: `dark`), VersaTiles as fallback |
| `off` | no map: the tab and the small maps are gone; place names and search by place still work (they need no server) |
| `LIGHT_URL DARK_URL` | your own MapLibre styles over https, e.g. a self-hosted tile server; everything a style loads (tiles, fonts, icons) must come from its own host, which the web app's CSP then allows |

The apps get the setting at sign-in (`map` in `/api/me`). The light or dark style follows the device's appearance.

## Software and data

- Map rendering: MapLibre GL JS 6 (web, and inside the Mac app's map view), MapLibre React Native 11 (Android); BSD-3 /
  MIT, no telemetry, no key.
- Map data: © OpenStreetMap contributors (ODbL), tiles © OpenMapTiles / OpenFreeMap, or VersaTiles. The map shows this
  attribution.
- Place names: [GeoNames](https://www.geonames.org/), CC BY 4.0.
