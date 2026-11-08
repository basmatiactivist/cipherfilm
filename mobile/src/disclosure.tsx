// Before Android's photo permission prompt: what Cipherfilm reads and where it goes, in the app's own words, with
// Continue / Not now (Google Play's prominent disclosure rule, docs/play/REQUIREMENTS.md §4.5). Shown every time the
// app is about to ask, so Android's prompt never comes without it. "Not now" asks nothing.
import { useCallback, useRef, useState, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { Button, Dialog, Portal, Text } from "react-native-paper";
import { session } from "./session";
import { requestMediaAccess } from "./mediaAccess";
import { t } from "./i18n";

type Why = "backup" | "freeSpace";

/** The disclosure, and a function that shows it and asks Android after Continue; it gives what is allowed then. */
export function useMediaDisclosure(): { ask: (why: Why) => Promise<"full" | "partial" | "none">; dialog: ReactNode } {
  const [why, setWhy] = useState<Why | null>(null);
  const answer = useRef<((go: boolean) => void) | null>(null);
  const close = (go: boolean) => { setWhy(null); answer.current?.(go); answer.current = null; };
  const ask = useCallback(async (w: Why) => {
    const go = await new Promise<boolean>((done) => { answer.current = done; setWhy(w); });
    if (!go) return "none" as const;
    return requestMediaAccess(w === "backup");
  }, []);
  const server = session().server.replace(/^https:\/\//, "") || t("your server");
  const dialog = (
    <Portal>
      <Dialog visible={why !== null} onDismiss={() => close(false)}>
        <Dialog.Title>{t("Access to your photos and videos")}</Dialog.Title>
        <Dialog.ScrollArea style={{ paddingHorizontal: 24 }}>
          <ScrollView>
            {why === "freeSpace" ? (
              <Text variant="bodyMedium" style={{ marginTop: 8 }}>
                {t("Cipherfilm reads the names and sizes of photos and videos on this phone to find the ones already backed up to {server}. Nothing is uploaded or sent anywhere.", { server })}
              </Text>
            ) : (
              <>
                <Text variant="bodyMedium" style={{ marginTop: 8 }}>
                  {t("Cipherfilm reads the photos and videos in the folders you choose, including where they were taken, to back them up. This also happens in the background when the app is closed.")}
                </Text>
                <Text variant="bodyMedium" style={{ marginTop: 12 }}>
                  {t("Each file is encrypted on this phone, then uploaded only to your server ({server}). The developer of Cipherfilm never receives your photos or anything about them.", { server })}
                </Text>
              </>
            )}
            <Text variant="bodyMedium" style={{ marginVertical: 12 }}>
              {t("Android asks next. If you allow only some photos, Cipherfilm backs up just those.")}
            </Text>
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          <Button onPress={() => close(false)}>{t("Not now")}</Button>
          <Button mode="contained" onPress={() => close(true)}>{t("Continue")}</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
  return { ask, dialog };
}
