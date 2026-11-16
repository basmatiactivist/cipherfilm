// "Free up space" (app/free-space.tsx): which photos and videos on this phone are already safely in the library.
import type { PhoneMedia } from "../modules/cf-native/src/CfNativeModule";
import type { Item } from "./library";
import { onlyOwn } from "./ownUploads";
import { fingerprint } from "./prints";

/** The phone's files with the same name and size as a finished item this phone uploaded itself. Name and size alone
 *  prove nothing (ownUploads.ts): an item someone else added to the account never makes a phone original look safe
 *  to remove. */
export async function alreadyIn(userId: string | undefined, items: Item[], media: PhoneMedia[]): Promise<PhoneMedia[]> {
  const own = await onlyOwn(userId, items.filter((it) => it.meta && !it.broken && it.meta.size > 0));
  const prints = new Set<string>();
  for (const it of own) prints.add(await fingerprint(it.meta!.name, it.meta!.size));
  const out: PhoneMedia[] = [];
  for (const m of media) if (m.size > 0 && prints.has(await fingerprint(m.name, m.size))) out.push(m);
  return out;
}
