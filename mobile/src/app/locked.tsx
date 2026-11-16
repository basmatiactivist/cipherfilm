import { useEffect, useRef, useState } from "react";
import { Keyboard, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Text } from "react-native-paper";
import { Gallery } from "../Gallery";
import { Icon } from "../icons";
import { closeLockedFolder, deviceCheck, openLockedFolder, passwordCheck, useLockedFolder } from "../lockedFolder";
import { refreshLibrary } from "../libraryStore";
import { Column, Field, Problem, Screen, Title, useAppTheme } from "../ui";
import { useAction } from "../useAction";
import { busyIcon } from "../Loader";
import { text } from "../tokens";
import { t } from "../i18n";

/**
 * The locked folder (lockedFolder.ts): asks for the phone's fingerprint, face or screen lock every time it opens, even
 * while the library is unlocked; the account password where the phone has none set up (or instead, if the person
 * prefers). Leaving this screen closes the folder: its list and decrypted thumbnails leave memory.
 */
export default function Locked() {
  const th = useAppTheme();
  const { open, items } = useLockedFolder();
  const [how, setHow] = useState<"device" | "password">("device");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  const asked = useRef(false);

  const check = () => run(async () => {
    const r = await deviceCheck();
    if (r === "passed") openLockedFolder();
    else if (r === "password") setHow("password");
  });
  const withPassword = () => run(async () => {
    Keyboard.dismiss();
    await passwordCheck(password);
    setPassword("");
    openLockedFolder();
  });

  // closed when this screen opens (a fresh check every time) and when it is left
  useEffect(() => {
    closeLockedFolder();
    if (!asked.current) { asked.current = true; check(); }
    return () => closeLockedFolder();
  }, []);

  if (open) {
    return (
      <Gallery
        items={items} loading={false} onRefresh={() => { refreshLibrary(); }} folder="locked"
        header={
          <View>
            <Appbar.Header style={{ backgroundColor: th.colors.background }}>
              <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
              <Appbar.Content title={t("Locked folder")} titleStyle={text.page} />
            </Appbar.Header>
            {items?.length ? (
              <Text variant="bodyMedium" style={[st.note, { color: th.colors.onSurfaceVariant }]}>
                {t("Only here, nowhere else in the app. Nothing of them is kept on this phone.")}
              </Text>
            ) : null}
          </View>
        }
        empty={
          <View style={st.empty}>
            <View style={[st.disc, { backgroundColor: th.colors.primaryContainer }]}><Icon name="lock" size={30} color={th.colors.primary} /></View>
            <Text variant="headlineSmall" style={{ textAlign: "center", marginBottom: 8 }}>{t("The locked folder is empty")}</Text>
            <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, maxWidth: 320 }}>
              {t("Select photos, then More › Move to locked folder. They are then shown only here, after your fingerprint or screen lock, and not in the photos grid, albums, search, people or the map.")}
            </Text>
          </View>
        }
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
      </Appbar.Header>
      <Screen form>
        <Column>
          <View style={[st.disc, { backgroundColor: th.colors.primaryContainer, alignSelf: "center" }]}><Icon name="lock" size={30} color={th.colors.primary} /></View>
          <Title>{t("Locked folder")}</Title>
          <Text variant="bodyMedium" style={{ marginBottom: 24, color: th.colors.onSurfaceVariant }}>
            {how === "device" ? t("Confirm it's you to open it. It asks every time.") : t("This phone has no fingerprint or screen lock set up. Enter your account password to open the locked folder.")}
          </Text>
          <Problem>{error}</Problem>
          {how === "device" ? (
            <>
              <Button mode="contained" icon="fingerprint" onPress={check} disabled={busy} contentStyle={{ height: 48 }} style={{ marginBottom: 12 }}>{t("Open")}</Button>
              <Button mode="text" onPress={() => setHow("password")} disabled={busy}>{t("Use password instead")}</Button>
            </>
          ) : (
            <>
              <Field label={t("Password")} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={withPassword}
                hint={busy && password ? t("Checking…") : undefined} />
              <Button mode="contained" onPress={withPassword} icon={busy && !!password ? busyIcon : undefined} disabled={busy || !password} contentStyle={{ height: 48 }}>{t("Open")}</Button>
            </>
          )}
        </Column>
      </Screen>
    </View>
  );
}

const st = StyleSheet.create({
  note: { paddingHorizontal: 16, paddingBottom: 4 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  disc: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", marginBottom: 16 },
});
