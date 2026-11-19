// The short introduction (app/welcome.tsx): shown once on this phone, the first time the library opens, and again from
// Account. Whether it was seen is this phone's, kept in the app's private files (like shake.ts).
const FILE = () => {
  const { File, Paths } = require("expo-file-system") as typeof import("expo-file-system");
  return new File(Paths.document, "intro.json");
};

let seen: boolean | undefined;

export function introSeen(): boolean {
  if (seen === undefined) {
    try { const f = FILE(); seen = f.exists && JSON.parse(f.textSync()).seen === true; } catch { seen = true; } // unreadable: don't block the library
  }
  return seen;
}

export function markIntroSeen() {
  seen = true;
  Promise.resolve().then(() => FILE().write(JSON.stringify({ seen: true }))).catch(() => { /* asks again next start */ });
}
