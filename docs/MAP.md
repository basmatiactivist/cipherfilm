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
  1,000 inhabitants, with its region and country, from GeoNames), and are looked up on the device: the place whose
  edge is nearest, a place reaching about 0.004 km per square root of its population around its point (Paris 6 km, at
  most 15 km), so the Eiffel Tower is in Paris and a town next to a city stays itself; within 50 km, else only the
  country (within 300 km), at sea nothing. No coordinates are sent anywhere to name them.
  `scripts/places.mjs` builds the file; it is the same for everyone, so it says nothing about anyone's photos.
  The Android app shows the country in its own language ("Zürich, Schweiz"), from Android's translations; search
  finds a country by either name ("schweiz", "switzerland").
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

## Turning it on

The map is off for every account on every device until the person turns it on. The first time they open the Map tab,
the app asks, names the map server(s) and says what they see; nothing is loaded before "Turn on map", and "Not now"
leaves it off. While it is off, a photo's details offer "Show on the map", which only opens that question. Account ›
Map (Settings › General › Map on the Mac) turns it off again; on Android that also clears the map's cache of loaded
map images, as locking and signing out do.

What a device stores is the list of map servers the person agreed to. If the Cipherfilm server later names other
ones (`MAP_STYLE`), every device asks again before loading anything from them.

Search by place adds the photos of a place to the other results, ahead of them; a word narrows a longer search to a
place only when it is that place's whole name ("zurich beach"), so common words ("see", "berg") still search for what
is in the photos.

## Settings

`MAP_STYLE` on the server (docs/SELF-HOSTING.md):

| Value | Effect |
|---|---|
| empty (default) | OpenFreeMap (light: `positron`, dark: `dark`), VersaTiles as fallback |
| `off` | no map: the tab and the small maps are gone; place names and search by place still work (they need no server) |
| `LIGHT_URL DARK_URL` | your own MapLibre styles over https, e.g. a self-hosted tile server; everything a style loads (tiles, fonts, icons) must come from its own host, which the web app's CSP then allows; see [Your own map tiles](#your-own-map-tiles) |

The apps get the setting at sign-in (`map` in `/api/me`). The light or dark style follows the device's appearance.

## Your own map tiles

A self-hosted server can use its own map server instead of OpenFreeMap. Then no outside map provider sees anything:
the map requests go to a server you run (or choose), and the privacy policy's map part applies to that server and its
operator, not to OpenFreeMap or VersaTiles.

What the apps need is two [MapLibre style](https://maplibre.org/maplibre-style-spec/) files, one for light and one for
dark mode, each a JSON file reachable over https. A style names where its tiles (the map data), glyphs (fonts) and
sprite (icons) come from. Any map server that serves MapLibre styles works, for example a self-hosted
[VersaTiles](https://versatiles.org) or [OpenFreeMap](https://github.com/hyperknot/openfreemap) instance, or
[TileServer GL](https://github.com/maptiler/tileserver-gl); their own guides cover downloading map data and running
them.

1. **Put the map server behind https**, on a host the devices can reach (your domain, your LAN, or your tailnet, the
   same way they reach Cipherfilm), with a certificate the devices trust: a public one (for example from Let's Encrypt,
   which Caddy gets by itself, as in compose.yaml for Cipherfilm, or `tailscale cert` on a tailnet). With a self-signed or private certificate
   browsers and the Mac app refuse the map ("the map couldn't be loaded"), even when Cipherfilm itself was opened
   past a warning.
2. **Check the styles.** Every URL inside them (`sources` › `url` or `tiles`, `glyphs`, `sprite`) must point at the
   same host as the style itself: the web app's and the Mac app's Content-Security-Policy allow the styles' hosts and
   nothing else, so a font or tile from another host is blocked. To list the hosts a style uses:

   ```sh
   curl -s https://maps.example.com/styles/light.json | grep -oE 'https?://[^/"]+' | sort -u
   ```

   If a style points somewhere else, edit its URLs (or serve those files from your host) before using it. When the
   style uses a TileJSON `url`, check that file's `tiles` too.
3. **Allow cross-origin requests.** The web app (on your Cipherfilm address) and the Mac app's map view load the map
   from another origin, so the map server must answer with `Access-Control-Allow-Origin: *` (or your Cipherfilm
   address plus `cfmap://app` for the Mac app). Most map servers send it already. No cookies or logins: the apps send
   none to the map server.
4. **Set `MAP_STYLE`** in the server's `.env` to the two style URLs, light first, separated by a space, and restart:

   ```sh
   MAP_STYLE="https://maps.example.com/styles/light.json https://maps.example.com/styles/dark.json"
   ```

   The server refuses anything that isn't two https URLs (or empty, or `off`) at start, and builds the web app's
   Content-Security-Policy from these hosts. One style for both modes works too: give the same URL twice.
5. **Check it.** The apps load the setting from the server when someone signs in or unlocks, so sign out and in (or
   lock and unlock) on each device. The question before the map then names your map server's host instead of
   OpenFreeMap. If the map stays empty, open the browser's developer tools on the web app: a blocked request
   ("Content-Security-Policy") means a style URL points at another host (step 2), a CORS error means step 3, a
   certificate error means step 1.
6. **Keep the attribution.** Map data from OpenStreetMap needs its credit; put it in the style's source `attribution`
   (for example `© OpenStreetMap contributors`), and the map shows it.

With your own styles there is no fallback: if your map server is down, the map says it couldn't be loaded
until it is back. Place names and search by place don't use the map server and keep working.

## Software and data

- Map rendering: MapLibre GL JS 6 (web, and inside the Mac app's map view), MapLibre React Native 11 (Android); BSD-3 /
  MIT, no telemetry, no key.
- Map data: © OpenStreetMap contributors (ODbL), tiles © OpenMapTiles / OpenFreeMap, or VersaTiles. The map shows this
  attribution.
- Place names: [GeoNames](https://www.geonames.org/), CC BY 4.0.
