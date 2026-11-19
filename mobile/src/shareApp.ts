// "Share Cipherfilm": a link to the app for someone else, handed to Android's share sheet (which also has "Copy").
// The Play build shares its store listing, the GitHub build the website (where both ways to install are). Nothing
// about the person, the server or the library goes into it.
import { isPlayBuild } from "./store";
import { t } from "./i18n";

export const PLAY_LISTING = "https://play.google.com/store/apps/details?id=app.cipherfilm";
export const WEBSITE = "https://cipherfilm.app";

export const appLink = (play: boolean = isPlayBuild()) => (play ? PLAY_LISTING : WEBSITE);

/** What the share sheet gets: one short line and the link. */
export function shareMessage(play?: boolean): string {
  return t("Cipherfilm keeps photos and videos end-to-end encrypted, on your own server. {link}", { link: appLink(play) });
}
