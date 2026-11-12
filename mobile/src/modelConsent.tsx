// The question before the search models are downloaded from Hugging Face (search/models.ts, docs/MODELS.md), in the
// words of the map's (app/map.tsx): what, how big, from whom, what they learn, and the two buttons.
import { Linking } from "react-native";
import { Button, Dialog, Portal, Text } from "react-native-paper";
import N from "../modules/cf-native/src/CfNativeModule";
import { downloadSize, needed, type Clip } from "./search/models";
import { privacyUrl } from "./store";
import { expectAway } from "./autolock";
import { useAppTheme } from "./ui";
import { locale, t } from "./i18n";

export interface ConsentAsk { faces: boolean; clip: Clip; indexes: boolean }

const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6)).toLocaleString(locale())} MB`;

/** Which models the download holds, in words, by what they are for (the files and sizes come from the shared list,
 *  server/models.json, whichever model the account uses). */
export function modelWords(a: ConsentAsk): string {
  const files = needed(a.faces, a.clip, a.indexes);
  return files.some((m) => m.faces) ? t("the search model and the face models") : t("the search model");
}

/** What the download fetches for these settings: the files not on this phone yet. */
export const askBytes = (a: ConsentAsk) => downloadSize(a.faces, a.clip, a.indexes) || needed(a.faces, a.clip, a.indexes).reduce((n, m) => n + m.size, 0);

export function ModelConsentDialog(p: { ask: ConsentAsk | null; wifiOnly: boolean; onYes: () => void; onLater: () => void }) {
  const th = useAppTheme();
  const a = p.ask;
  const metered = !N.backupState().unmetered;
  return (
    <Portal>
      <Dialog visible={!!a} onDismiss={p.onLater}>
        <Dialog.Title>{t("Download the search models?")}</Dialog.Title>
        {a ? (
          <Dialog.ScrollArea style={{ paddingHorizontal: 24 }}>
            <Text variant="bodyMedium" style={{ marginTop: 8 }}>
              {t("Search runs on this phone with open models. The app downloads them once for this phone: {what}, {size} in all.", { what: modelWords(a), size: mb(askBytes(a)) })}
            </Text>
            <Text variant="bodyMedium" style={{ marginTop: 12 }}>
              {t("They come from the public site where these models are published (which one: see the privacy policy). That site sees this phone's IP address and that it downloaded these public files. It gets no photos, faces, search words or account data.")}
            </Text>
            <Text variant="bodyMedium" style={{ marginTop: 12 }}>
              {t("Each file is checked (SHA-256) before it is used.")}{" "}
              {metered ? (p.wifiOnly ? t("The download waits for Wi-Fi.") : t("You're not on Wi-Fi: this uses mobile data.")) : null}
            </Text>
            <Text variant="bodySmall" style={{ marginTop: 12, marginBottom: 8, color: th.colors.onSurfaceVariant }}>
              {t("Turning search off deletes the models again.")}{" "}
              <Text accessibilityRole="link" style={{ color: th.colors.primary, fontWeight: "600", textDecorationLine: "underline" }}
                onPress={() => { expectAway(); Linking.openURL(`${privacyUrl()}#models`); }}>{t("Privacy policy")}</Text>
            </Text>
          </Dialog.ScrollArea>
        ) : null}
        <Dialog.Actions style={{ flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <Button mode="contained" onPress={p.onYes}>{t("Download and turn on")}</Button>
          <Button onPress={p.onLater}>{t("Not now")}</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
