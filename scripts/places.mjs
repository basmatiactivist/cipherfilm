#!/usr/bin/env node
// Builds web/src/places/places-v1.bin, the place names the apps look up on the device (docs/MAP.md): every place with
// at least 1,000 people from GeoNames (cities1000), with its region (admin1) and country. A photo's coordinates
// never leave the device: the nearest place is found in this file. Data: GeoNames, CC BY 4.0 (geonames.org).
//   curl -O https://download.geonames.org/export/dump/{cities1000.zip,admin1CodesASCII.txt,countryInfo.txt}
//   unzip cities1000.zip && node scripts/places.mjs <that folder> web/src/places/places-v1.bin
//
// Format, little endian (web/src/places/places.ts reads it, and the Mac's Places.swift):
//   "CFPL" u8 version=1, 3 bytes 0
//   u32 n, u32 jsonLen
//   i32 lat[n], i32 lon[n]     (degrees x 100000)
//   u16 admin[n]               (index into admins, 65535 = none)
//   u8  country[n]             (index into countries)
//   u8  size[n]                (population class: round(log2(population)), 0 = unknown)
//   jsonLen bytes JSON         {"countries":[["CH","Switzerland"],...],"admins":[[countryIndex,"Zurich"],...]}
//   names                      n UTF-8 names, each ended by a 0 byte, in the order above
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: node scripts/places.mjs <folder with cities1000.txt, admin1CodesASCII.txt, countryInfo.txt> <out.bin>");
  process.exit(2);
}
const lines = (f) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));

const countries = [];
const countryIdx = new Map();
for (const l of lines("countryInfo.txt")) {
  const c = l.split("\t");
  countryIdx.set(c[0], countries.length);
  countries.push([c[0], c[4]]);
}
if (countries.length > 255) throw new Error("more than 255 countries");

const admins = [];
const adminIdx = new Map();
for (const l of lines("admin1CodesASCII.txt")) {
  const [code, name] = l.split("\t"); // "CH.ZH", "Zurich"
  const cc = code.split(".")[0];
  if (!countryIdx.has(cc)) continue;
  adminIdx.set(code, admins.length);
  admins.push([countryIdx.get(cc), name]);
}
if (admins.length >= 65535) throw new Error("too many regions");

const rows = [];
for (const l of lines("cities1000.txt")) {
  const c = l.split("\t");
  const lat = Number(c[4]), lon = Number(c[5]), pop = Number(c[14]) || 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !countryIdx.has(c[8])) continue;
  // the town, not its districts (PPLX) or places that are gone (historical, abandoned, destroyed)
  if (["PPLX", "PPLH", "PPLQ", "PPLW"].includes(c[7])) continue;
  const name = c[1].replace(/\0/g, "").trim();
  if (!name) continue;
  rows.push({ lat: Math.round(lat * 1e5), lon: Math.round(lon * 1e5), admin: adminIdx.get(`${c[8]}.${c[10]}`) ?? 65535, country: countryIdx.get(c[8]), size: pop > 0 ? Math.min(255, Math.round(Math.log2(pop))) : 0, name });
}
// a stable order (by latitude, then longitude): the same input gives the same file
rows.sort((a, b) => a.lat - b.lat || a.lon - b.lon || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// a city's numbered parts ("Paris 04 Hôtel-de-Ville", "Marseille 12", "Lyon 3e Arrondissement") are listed as places
// of their own: a photo there is in the city. Dropped when a bigger place within 15 km has the start of their name.
const cellOf = (r) => `${Math.floor(r.lat / 1e5 / 0.25)}:${Math.floor(r.lon / 1e5 / 0.25)}`;
const cells = new Map();
for (const r of rows) (cells.get(cellOf(r)) ?? cells.set(cellOf(r), []).get(cellOf(r))).push(r);
const kmBetween = (a, b) => {
  const k = Math.PI / 180, la = (a.lat / 1e5) * k, lb = (b.lat / 1e5) * k;
  const h = Math.sin((lb - la) / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(((b.lon - a.lon) / 1e5) * k / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const part = (r) => {
  const [y, x] = cellOf(r).split(":").map(Number);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const big of cells.get(`${y + dy}:${x + dx}`) ?? []) {
      if (big === r || big.size <= r.size || big.name.length >= r.name.length) continue;
      if (/^[ (\-–,]/.test(r.name.slice(big.name.length)) && r.name.startsWith(big.name) && kmBetween(r, big) <= 15) return true;
    }
  }
  return false;
};
const parts = rows.filter(part);
for (const p of parts) rows.splice(rows.indexOf(p), 1);

const n = rows.length;
const json = Buffer.from(JSON.stringify({ countries, admins }), "utf8");
const names = Buffer.concat(rows.map((r) => Buffer.from(r.name + "\0", "utf8")));
const head = Buffer.alloc(16);
head.write("CFPL", 0, "ascii");
head.writeUInt8(1, 4);
head.writeUInt32LE(n, 8);
head.writeUInt32LE(json.length, 12);
const lat = Buffer.alloc(n * 4), lon = Buffer.alloc(n * 4), admin = Buffer.alloc(n * 2), country = Buffer.alloc(n), size = Buffer.alloc(n);
rows.forEach((r, i) => {
  lat.writeInt32LE(r.lat, i * 4);
  lon.writeInt32LE(r.lon, i * 4);
  admin.writeUInt16LE(r.admin, i * 2);
  country.writeUInt8(r.country, i);
  size.writeUInt8(r.size, i);
});
writeFileSync(out, Buffer.concat([head, lat, lon, admin, country, size, json, names]));
console.log(`${out}: ${n} places, ${admins.length} regions, ${countries.length} countries, ${(head.length + lat.length * 2 + admin.length + country.length * 2 + json.length + names.length) / 1e6} MB`);
