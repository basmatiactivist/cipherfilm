# Memories: On this day, trips, year recaps and custom reviews

Everything here is worked out on the device from the decrypted capture dates and coordinates. There is no endpoint
for it and nothing is stored: the results live in memory and are worked out again when the library changes. The
server sees only the thumbnail requests for the covers, the same requests the grid makes. One setting (Account ›
Memories on the web and Android, Settings › General › Memories on the Mac) turns them off on that device. Custom
reviews are the exception to "nothing is stored": they are saved, encrypted, for all the person's devices (below).

The rules are written once in TypeScript (`web/src/memories/`), used by the web app and by the Android app (the
`@memories` alias), and ported to Swift for the Mac (`mac/Sources/CipherfilmCore/Memories.swift`, `Trips.swift`,
`Recap.swift`). `web/src/memories/testdata/trips.json` holds a library and the trips and recap it must give; the web
tests (`trips.test.ts`) and the Mac tests (`TripsTests.swift`) both check it, so a change on one side that isn't made
on the other fails.

## On this day

Photos taken within three days of today's date in each earlier year, one card per year (`memories.ts`); a year with
more than 200 shows 200, spread over their time.

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
day, spread over the days, then (a month with photos on fewer than four days) others of those days, spread too
(`recap.ts` `highlights`). Videos and screenshots are left out where a month has other photos; nothing without a
thumbnail is shown.

## Custom reviews

A search the person saves ("dogs", "Anna in Zürich", "beach 2019"), played as a story like the year in review, daily,
weekly or monthly, with other photos each time. Made, changed and deleted in Account › Memories › Custom reviews on
the web and Android (Settings › General › Memories on the Mac); the due ones show in "Your reviews" above "Your
years". The rules are in `web/src/memories/custom.ts` (web and Android) and `CustomReview.swift` (Mac), checked
against the same fixture (`testdata/custom.json`).

- **What it shows.** The search runs on the device exactly like the search box (words, people, places, dates,
  favorites, videos, text in photos, what the photos show), its close matches only, with that device's explicit
  filter (docs/SEARCH.md "Explicit content"). Nothing damaged, trashed, in the locked folder or without a thumbnail.
- **When.** A review is due once a day, a week (Monday to Sunday) or a calendar month, in local time, until it is
  watched on any device. A new review is due at once.
- **Other photos each time.** The photos not shown lately come first; when fewer are left than the review shows, those
  shown longest ago fill up. They are spread over the months they were taken in (the months in a random order, one
  photo from each in turn, a favorite twice as likely, screenshots and videos only where a month has nothing else).
  The randomness is seeded by the review and the period, and what a period showed is remembered, so the story is the
  same when opened again in that period, also on another device. Up to 600 shown photos are remembered per review.
- **The story.** The cover (the review's name, "12 of 214 photos", the period), the photos by year (at most six a
  slide), the end ("Next one tomorrow").
- **Notifications (Android).** Optional per review: "A review is ready", hidden on the lock screen, between 9:00 and
  21:00, at most once a period. The background task can't read the reviews (no master key there), so the app keeps an
  on-device list of review ids, how often, when last watched and whether there were photos; no names, no searches.
  The web and the Mac show the row only.
- **Google Play.** The Android app from Google Play never shows a review whose search or name is an explicit search
  word, and needs the search model on the device to check that; such a review stays in the document for the other
  devices.
- **Stored.** One document per account (`user_blobs` "reviews", docs/CRYPTO.md), encrypted with a subkey of the master
  key and padded to steps of 4096 bytes: the reviews (name, search, how often, how many photos, notify), what each
  showed, and deleted reviews' ids for 90 days (so a device that hadn't seen a delete can't bring one back). The
  server sees that the document exists, its padded size and when it is written: when a review is made, changed or
  deleted, and once when a due review is watched. At most 20 reviews.

## Not included

- Items in the trash or that couldn't be verified never count; an item in the locked folder never counts either.
  Archived items are left out of On this day but still count for trips and year recaps (docs/EDITING.md).
- No aesthetic scoring: the search models don't give one, so highlights are favorites, then spread over the days.
- The web and Mac apps are in English; town names are those of the place file (English or local), not translated.
