// "Share Cipherfilm": a link to the app for someone else, handed to Android's share sheet (which also has "Copy").
// The Play build shares its store listing, the GitHub build the website (where both ways to install are). Nothing
// about the person, the server or the library goes into it.
import { isPlayBuild } from "./store";
import { t } from "./i18n";

export const PLAY_LISTING = "https://play.google.com/store/apps/details?id=app.cipherfilm";
export const WEBSITE = "https://cipherfilm.app";

export const appLink = (play: boolean = isPlayBuild()) => (play ? PLAY_LISTING : WEBSITE);

// "Rate Cipherfilm": only in the Play build (the GitHub build has no store page to rate on). It opens the listing in
// the Play Store app, or in the browser if there is no Play Store; no review library, no prompt, nothing is sent.
export const PLAY_APP_LISTING = "market://details?id=app.cipherfilm";
export const rateOffered = (play: boolean = isPlayBuild()) => play;

/** What the share sheet gets: one short line and the link. */
export function shareMessage(play?: boolean): string {
  return t("Cipherfilm keeps photos and videos end-to-end encrypted, on your own server. {link}", { link: appLink(play) });
}
