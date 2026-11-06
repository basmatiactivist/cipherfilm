import { useEffect, useRef, useState } from "react";
import { Keyboard } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button, Dialog, Portal, Text } from "react-native-paper";
import { Column, Field, Lead, Problem, Screen, Title } from "../ui";
import { declineBiometric, enableBiometric, offerBiometric, signOut, unlockWithBiometric, unlockWithPassword, useSession } from "../session";
import { useAction } from "../useAction";

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
  // asks for the fingerprint at once, except after "Lock now" or an automatic lock: the lock screen then shows, and the
  // phone may be in someone else's hand
  useEffect(() => { if (biometric && !byHand && !asked.current) { asked.current = true; bio(); } }, [biometric]);
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
        <Title>Unlock your library</Title>
        <Lead>{me?.user.email}</Lead>
        {then === "share" ? <Text variant="bodyMedium" style={{ marginBottom: 16 }}>Another app shared something with Cipherfilm. After unlocking you see what it is, and nothing is uploaded until you choose to.</Text> : null}
        <Problem>{error}</Problem>
        {biometric ? <Button mode="contained" icon="fingerprint" onPress={bio} disabled={busy} contentStyle={{ height: 48 }} style={{ marginBottom: 24 }}>Use fingerprint</Button> : null}
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={go}
          hint={busy && password ? "Unlocking your keys, this takes a second or two" : undefined} />
        <Button mode={biometric ? "outlined" : "contained"} onPress={go} loading={busy && !!password} disabled={busy || !password} contentStyle={{ height: 48 }}>Unlock</Button>
        <Button mode="text" onPress={() => setConfirmOut(true)} style={{ marginTop: 8 }}>Sign out</Button>
      </Column>
      <Portal>
        <Dialog visible={offerBio} onDismiss={done}>
          <Dialog.Title>Unlock with your fingerprint next time?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">Your key is then kept in this phone's secure hardware and only released after your fingerprint or face. You can turn it off under Account.</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={async () => { await declineBiometric().catch(() => {}); done(); }}>Not now</Button>
            <Button onPress={async () => { try { await enableBiometric(); } catch { /* stays off; Account offers it again */ } done(); }}>Turn on</Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={confirmOut} onDismiss={() => setConfirmOut(false)}>
          <Dialog.Title>Sign out of this phone?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">Your photos stay in Cipherfilm. This phone deletes its copies of your library, the backup and search settings, and its saved key; the automatic backup stops.</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmOut(false)}>Cancel</Button>
            <Button onPress={async () => { setConfirmOut(false); await signOut(); router.replace("/signin"); }}>Sign out</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </Screen>
  );
}
