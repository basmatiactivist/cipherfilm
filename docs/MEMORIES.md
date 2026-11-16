# Memories: On this day, trips and year recaps

Everything here is worked out on the device from the decrypted capture dates and coordinates. There is no endpoint
for it and nothing is stored: the results live in memory and are worked out again when the library changes. The
server sees only the thumbnail requests for the covers, the same requests the grid makes. One setting (Account ›
Memories on the web and Android, Settings › General › Memories on the Mac) turns all three off on that device.

The rules are written once in TypeScript (`web/src/memories/`), used by the web app and by the Android app (the
`@memories` alias), and ported to Swift for the Mac (`mac/Sources/CipherfilmCore/Memories.swift`, `Trips.swift`,
`Recap.swift`). `web/src/memories/testdata/trips.json` holds a library and the trips and recap it must give; the web
tests (`trips.test.ts`) and the Mac tests (`TripsTests.swift`) both check it, so a change on one side that isn't made
on the other fails.

## On this day

Photos taken within three days of today's date in each earlier year, one card per year (`memories.ts`).

## Trips

1. **Home.** The photos with a location are put into cells of 0.25° (about 25 km). Home is the cell with photos on the
   most different days (not the most photos, so a busy holiday doesn't win), and its photos' median position. A year
   with photos on at least 30 days has a home of its own, so a move is followed; other years use the whole library's.
2. **Away.** A photo farther than 80 km from its year's home is taken away.
3. **Trips.** Days with photos taken away, at most one day without photos between them, make a trip; a day with photos
   only at home ends it. A trip needs at least 5 such photos on at least 2 days (a day out isn't a trip). Photos
   without a location taken between a trip's first and last photo belong to it.
4. **Name.** The place holding at least half of the trip's located photos ("Rome"), else such a region ("Tuscany"),
   else the country, else the countries ("Italy and France"), with the months ("May 2026", "May – June 2026"). Place
   names come from the GeoNames file in the apps (docs/MAP.md); towns are named as the file names them, countries and
   months follow the app's language on Android.

A trip shows as saved once an album holds at least 80% of its photos. "Save as album" makes an ordinary album, named
like the trip, with an encrypted name like every album; that is the only time anything about a trip reaches the server.

## Year recaps

Every earlier year with photos, and the current year from December. A recap counts the photos, videos, days and
countries, lists the five places and the five named people (when faces are on) in the most photos, the year's trips,
and shows four photos for every month: favorites first, spread over the month, then one photo from the middle of each
day, spread over the days. Screenshots and photos without a thumbnail are left out where there are others.

## Not included

- Items in the trash or that couldn't be verified never count; an item in a locked folder never counts either.
- No aesthetic scoring: the search models don't give one, so highlights are favorites, then spread over the days.
- The web and Mac apps are in English; town names are those of the place file (English or local), not translated.
