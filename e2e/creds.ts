import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * Passwords of the throwaway accounts the suite creates on a local dev stack. They are random per checkout and kept in
 * `.e2e-passwords.json` (git-ignored), so no password is ever written into the source. Use `pw("carol")` in a spec;
 * to sign in by hand on the dev stack, read the value from that file.
 */
const FILE = join(__dirname, ".e2e-passwords.json");

function load(): Record<string, string> {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}; } catch { return {}; }
}

export function pw(name: string): string {
  const all = load();
  if (!all[name]) {
    all[name] = "pw-" + randomBytes(9).toString("base64url");
    writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
  return all[name];
}
