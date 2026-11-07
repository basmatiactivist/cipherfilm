import { useRef, useState } from "react";
import { Keyboard } from "react-native";
import { router } from "expo-router";
import { Button, Dialog, Portal, Text } from "react-native-paper";
import { Column, Field, type FieldHandle, Lead, Problem, Screen, Title, useAppTheme } from "../ui";
import { declineBiometric, enableBiometric, login, offerBiometric, useSession } from "../session";
import { useAction } from "../useAction";
import { away } from "../autolock";
import { busyIcon } from "../Loader";

export default function SignIn() {
  const t = useAppTheme();
  const { server, notice } = useSession();
  const passwordField = useRef<FieldHandle>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [offerBio, setOfferBio] = useState(false);
  const { busy, error, run, setError } = useAction();
  const done = () => router.replace("/library");
  const go = () => run(async () => {
    Keyboard.dismiss();
    await login(email, password);
    setPassword("");
    if (await offerBiometric()) setOfferBio(true);
    else done();
  });
  return (
    <Screen form>
      <Column>
        <Title>Sign in</Title>
        <Lead>{server.replace(/^https:\/\//, "")}</Lead>
        <Problem>{error ?? notice}</Problem>
        <Field label="E-mail" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" textContentType="emailAddress" autoComplete="email" returnKeyType="next"
          onSubmitEditing={() => passwordField.current?.focus()} submitBehavior="submit" />
        <Field inputRef={passwordField} label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={go}
          hint={busy ? "Unlocking…" : undefined} />
        <Button mode="contained" onPress={go} icon={busy ? busyIcon : undefined} disabled={busy || !email || !password} contentStyle={{ height: 48 }}>Sign in</Button>
        <Button mode="text" onPress={() => router.push("/server")} style={{ marginTop: 8 }}>Use a different address</Button>
        <Text variant="bodySmall" style={{ color: t.colors.onSurfaceVariant, marginTop: 24 }}>
          New here, or forgot your password? Use Cipherfilm in the browser.
        </Text>
      </Column>
      <Portal>
        <Dialog visible={offerBio} onDismiss={done}>
          <Dialog.Title>Unlock with your fingerprint?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">Your key stays in this phone's secure hardware. You can turn this off in Account.</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={async () => { await declineBiometric().catch(() => {}); done(); }}>Not now</Button>
            <Button onPress={async () => { try { await away(enableBiometric); } catch (e) { setError((e as Error).message); } done(); }}>Turn on</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </Screen>
  );
}
