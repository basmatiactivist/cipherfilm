import { Redirect } from "expo-router";
import { getSharedPayloads } from "expo-sharing";
import { Screen } from "../ui";
import { useSession } from "../session";
import { Loading } from "../Loader";
import { t } from "../i18n";

/** Sends the person where they are in the flow: server, sign-in, unlock or the library. A share that started the
 *  app (it arrives without the share link on a cold start) goes on to the upload screen. */
export default function Index() {
  const { phase } = useSession();
  const shared = getSharedPayloads().length > 0;
  if (phase === "starting") return <Screen center><Loading label={t("Opening Cipherfilm…")} /></Screen>;
  if (phase === "noServer") return <Redirect href="/server" />;
  if (phase === "signedOut") return <Redirect href="/signin" />;
  if (phase === "locked") return <Redirect href={shared ? { pathname: "/unlock", params: { then: "share" } } : "/unlock"} />;
  return <Redirect href={shared ? "/share" : "/library"} />;
}
