import { useEffect, useRef, useState } from "react";
import { AppState, Keyboard } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button, Portal, Text } from "react-native-paper";
import { Column, Field, Lead, Problem, Screen, Title, Dialog } from "../ui";
import { declineBiometric, enableBiometric, offerBiometric, signOut, unlockWithBiometric, unlockWithPassword, useSession } from "../session";
import { useAction } from "../useAction";
import { away } from "../autolock";
import { busyIcon } from "../Loader";
import { t } from "../i18n";

export default function Unlock() {
  const { me, biometric, byHand } = useSession();
  const { then } = useLocalSearchParams<{ then?: string }>();
  const [password, setPassword] = useState("");
  const [offerBio, setOfferBio] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const { busy, error, run } = useAction();
  const asked = useRef(false);
  const done = () => router.replace(then === "share" ? "/share" : "/library");
  const bio = () => run(async () => { if (await unlockWithBiometric()) done(); });
  // asks for the fingerprint at once, as at app start, also after an automatic lock; not after "Lock now" or shaking
  // (the phone may be in someone else's hand). A lock in the background asks once the app is back on screen.
  useEffect(() => {
    if (!biometric || byHand) return;
    const ask = () => { if (!asked.current && AppState.currentState === "active") { asked.current = true; bio(); } };
    ask();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") ask(); });
    return () => sub.remove();
  }, [biometric, byHand]);
  const go = () => run(async () => {
    Keyboard.dismiss();
    await unlockWithPassword(password);
    setPassword("");
    if (await offerBiometric()) setOfferBio(true);
    else done();
  });
  return (
    <Screen form>
      <Column>
        <Title>{t("Unlock your library")}</Title>
        <Lead>{me?.user.email}</Lead>
        {then === "share" ? <Text variant="bodyMedium" style={{ marginBottom: 16 }}>{t("Another app shared files with Cipherfilm. Unlock to see them. Nothing is uploaded until you choose.")}</Text> : null}
        <Problem>{error}</Problem>
        {biometric ? <Button mode="contained" icon="fingerprint" onPress={bio} disabled={busy} contentStyle={{ height: 48 }} style={{ marginBottom: 24 }}>{t("Use fingerprint")}</Button> : null}
        <Field label={t("Password")} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={go}
          hint={busy && password ? t("Unlocking…") : undefined} />
        <Button mode={biometric ? "outlined" : "contained"} onPress={go} icon={busy && !!password ? busyIcon : undefined} disabled={busy || !password} contentStyle={{ height: 48 }}>{t("Unlock")}</Button>
        <Button mode="text" onPress={() => setConfirmOut(true)} style={{ marginTop: 8 }}>{t("Sign out")}</Button>
      </Column>
      <Portal>
        <Dialog visible={offerBio} onDismiss={done}>
          <Dialog.Title>{t("Unlock with your fingerprint next time?")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("Your key stays in this phone's secure hardware. You can turn this off in Account.")}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={async () => { await declineBiometric().catch(() => {}); done(); }}>{t("Not now")}</Button>
            <Button onPress={async () => { try { await away(enableBiometric); } catch { /* stays off; Account offers it again */ } done(); }}>{t("Turn on")}</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={confirmOut} onDismiss={() => setConfirmOut(false)}>
          <Dialog.Title>{t("Sign out of this phone?")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("Your photos stay in Cipherfilm. This phone deletes its copy of your library, its settings and its saved key, and backup stops.")}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmOut(false)}>{t("Cancel")}</Button>
            <Button onPress={async () => { setConfirmOut(false); await signOut(); router.replace("/signin"); }}>{t("Sign out")}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </Screen>
  );
}
