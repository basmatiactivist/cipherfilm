// The question before Back closes the app from a top-level place (exitConfirm.ts decides when). It says what goes on
// after closing: running uploads keep going in their notification (a foreground service, upload.ts).
// Its Back listener is added once, at the start, under the navigator's own: the navigator goes back while it can,
// a screen's own listener (a selection in the grid, Gallery.tsx) comes first, and only what is left reaches this one.
import { useEffect, useRef, useState } from "react";
import { BackHandler } from "react-native";
import { router, useSegments } from "expo-router";
import { Button, Portal, Text } from "react-native-paper";
import { Dialog, useAppTheme } from "./ui";
import { askBeforeClosing, setAskBeforeClosing, shouldAsk } from "./exitConfirm";
import { uploadsRunning } from "./upload";
import { t, tn } from "./i18n";

export function ExitDialog() {
  const th = useAppTheme();
  const segments = useSegments();
  const top = useRef<string | undefined>(undefined);
  top.current = segments[0] as string | undefined;
  const [open, setOpen] = useState(false);
  const [uploads, setUploads] = useState(0);
  const shown = useRef(false);
  shown.current = open;
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (shown.current) return false; // a second Back while it asks: closes, as Back always did
      if (!shouldAsk({ top: top.current, canGoBack: router.canGoBack(), on: askBeforeClosing() })) return false;
      setUploads(uploadsRunning());
      setOpen(true);
      return true;
    });
    return () => sub.remove();
  }, []);
  const close = () => { setOpen(false); BackHandler.exitApp(); };
  return (
    <Portal>
      <Dialog visible={open} onDismiss={() => setOpen(false)}>
        <Dialog.Title>{t("Close Cipherfilm?")}</Dialog.Title>
        <Dialog.Content>
          {uploads > 0 ? (
            <Text variant="bodyMedium" style={{ marginBottom: 12 }}>
              {tn(uploads, "{n} upload is still running. It goes on after closing; the notification shows how far it is.", "{n} uploads are still running. They go on after closing; the notification shows how far they are.")}
            </Text>
          ) : null}
          <Text variant={uploads > 0 ? "bodySmall" : "bodyMedium"} style={uploads > 0 ? { color: th.colors.onSurfaceVariant } : undefined}>
            {t("You can turn this question off in Account.")}
          </Text>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={() => setOpen(false)}>{t("Stay")}</Button>
          <Button onPress={close}>{t("Close")}</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
