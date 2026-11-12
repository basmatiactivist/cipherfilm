// Screens that show the library: none stays open, on top or further down the navigation stack, once it is locked or
// signed out (app/_layout.tsx).
export const PRIVATE = new Set(["library", "albums", "album", "photo", "edit", "account", "trash", "backup", "search", "people", "person", "favorites", "free-space", "search-settings", "map", "two-step", "devices", "duplicates", "admin"]);

interface NavState { routes?: { name: string; state?: NavState }[] }

/** Every route's first path segment in a navigation state, nested navigators included ("photo/[id]" is "photo"). */
export function routeNames(state: NavState | undefined): string[] {
  const out: string[] = [];
  for (const r of state?.routes ?? []) {
    out.push(r.name.split("/")[0]);
    out.push(...routeNames(r.state));
  }
  return out;
}

/** Whether the stack must be reset to the start: the library isn't open (locked, signed out) and a private screen is
 *  anywhere in it, not only on top. */
export function mustLeave(phase: string, names: (string | undefined)[]): boolean {
  if (phase === "unlocked" || phase === "starting") return false;
  return names.some((n) => !!n && PRIVATE.has(n));
}
