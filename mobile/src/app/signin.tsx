import { useEffect, useRef, useState } from "react";
import { Keyboard } from "react-native";
import { router } from "expo-router";
import { Button, Portal, Text } from "react-native-paper";
import { Column, Field, type FieldHandle, Lead, Problem, Screen, Title, useAppTheme, Dialog } from "../ui";
import { CodeExpired, type CodeStep, declineBiometric, enableBiometric, login, offerBiometric, useSession } from "../session";
import { cleanCode, codeReady, firstWay } from "../twoStep";
import { passkeysSupported } from "../passkeys";
import { useAction } from "../useAction";
import { away } from "../autolock";
import { busyIcon } from "../Loader";
import { t } from "../i18n";

export default function SignIn() {
  const th = useAppTheme();
  const { server, notice } = useSession();
  const passwordField = useRef<FieldHandle>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [offerBio, setOfferBio] = useState(false);
  const { busy, error, run, setError } = useAction();
  // two-step sign-in: the password was right, a code comes next
  const [step, setStep] = useState<CodeStep | null>(null);
  const [code, setCode] = useState("");
  // how the second step is given: a passkey, the app's code, or a recovery code
  const [how, setHow] = useState<"passkey" | "code" | "recovery">("code");
  const recovery = how === "recovery";
  const canPasskey = passkeysSupported();
  // leaving the screen mid-way: the key derived from the password goes
  const stepRef = useRef<CodeStep | null>(null);
  stepRef.current = step;
  useEffect(() => () => stepRef.current?.cancel(), []);
  const done = () => router.replace("/library");
  const signedIn = async () => {
    setPassword("");
    if (await offerBiometric()) setOfferBio(true);
    else done();
  };
  const go = () => run(async () => {
    Keyboard.dismiss();
    const next = await login(email, password);
    if (next) { setPassword(""); setCode(""); setHow(firstWay(next, canPasskey)); setStep(next); return; }
    await signedIn();
  });
  const startOver = () => { step?.cancel(); setStep(null); setCode(""); setHow("code"); setError(undefined); };
  const attempt = (f: (s: CodeStep) => Promise<void>) => run(async () => {
    if (!step) return;
    Keyboard.dismiss();
    try {
      await f(step);
    } catch (e) {
      setCode("");
      if (e instanceof CodeExpired) { setStep(null); setHow("code"); }
      throw e;
    }
    setStep(null);
    await signedIn();
  });
  const send = () => attempt((s) => s.finish(code));
  const usePasskey = () => attempt((s) => s.usePasskey());
  if (step) {
    const ways = ([["passkey", t("Use a passkey")], ["code", t("Use the authenticator app")], ["recovery", t("Use a recovery code")]] as const)
      .filter(([w]) => w !== how && (w !== "passkey" || (step.passkey && canPasskey)) && (w !== "code" || step.totp));
    return (
      <Screen form>
        <Column>
          <Title>{t("Two-step sign-in")}</Title>
          <Lead>{how === "passkey" ? t("Confirm with your passkey. Android asks for it, from your password manager or a security key.")
            : recovery ? t("Enter one of your recovery codes. Each one works once.") : t("Enter the 6-digit code from your authenticator app.")}</Lead>
          <Problem>{error}</Problem>
          {how === "passkey" ? (
            <Button mode="contained" onPress={usePasskey} icon={busy ? busyIcon : undefined} disabled={busy} contentStyle={{ height: 48 }}>{t("Use your passkey")}</Button>
          ) : (
            <>
              {recovery ? (
                <Field key="recovery" label={t("Recovery code")} value={code} onChangeText={(v) => setCode(cleanCode(v, true))} autoCapitalize="none" autoFocus
                  returnKeyType="go" onSubmitEditing={() => { if (codeReady(code, true)) send(); }} hint={busy ? t("Checking…") : undefined} />
              ) : (
                // one-time-code: React Native gives Android's autofill the SMS one-time-code hint, the nearest it has;
                // importantForAutofill so a password manager's autofill service (Bitwarden…) is asked for this field
                <Field key="totp" label={t("Code")} value={code} onChangeText={(v) => setCode(cleanCode(v, false))} keyboardType="number-pad" textContentType="oneTimeCode"
                  autoComplete="one-time-code" importantForAutofill="yes" maxLength={6} autoFocus returnKeyType="go" onSubmitEditing={() => { if (codeReady(code, false)) send(); }}
                  hint={busy ? t("Checking…") : undefined} />
              )}
              <Button mode="contained" onPress={send} icon={busy ? busyIcon : undefined} disabled={busy || !codeReady(code, recovery)} contentStyle={{ height: 48 }}>{t("Sign in")}</Button>
            </>
          )}
          {ways.map(([w, label]) => (
            <Button key={w} mode="text" onPress={() => { setHow(w); setCode(""); setError(undefined); }} disabled={busy} style={{ marginTop: 8 }}>{label}</Button>
          ))}
          <Button mode="text" onPress={startOver} disabled={busy}>{t("Start over")}</Button>
        </Column>
      </Screen>
    );
  }
  return (
    <Screen form>
      <Column>
        <Title>{t("Sign in")}</Title>
        <Lead>{server.replace(/^https:\/\//, "")}</Lead>
        <Problem>{error ?? notice}</Problem>
        <Field label={t("E-mail")} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" textContentType="emailAddress" autoComplete="email" returnKeyType="next"
          onSubmitEditing={() => passwordField.current?.focus()} submitBehavior="submit" />
        <Field inputRef={passwordField} label={t("Password")} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" returnKeyType="go" onSubmitEditing={go}
          hint={busy ? t("Unlocking…") : undefined} />
        <Button mode="contained" onPress={go} icon={busy ? busyIcon : undefined} disabled={busy || !email || !password} contentStyle={{ height: 48 }}>{t("Sign in")}</Button>
        <Button mode="text" onPress={() => router.push("/server")} style={{ marginTop: 8 }}>{t("Use a different address")}</Button>
        <Text variant="bodySmall" style={{ color: th.colors.onSurfaceVariant, marginTop: 24 }}>
          {t("New here, or forgot your password? Use Cipherfilm in the browser.")}
        </Text>
      </Column>
      <Portal>
        <Dialog visible={offerBio} onDismiss={done}>
          <Dialog.Title>{t("Unlock with your fingerprint?")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("Your key stays in this phone's secure hardware. You can turn this off in Account.")}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={async () => { await declineBiometric().catch(() => {}); done(); }}>{t("Not now")}</Button>
            <Button onPress={async () => { try { await away(enableBiometric); } catch (e) { setError((e as Error).message); } done(); }}>{t("Turn on")}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </Screen>
  );
}
