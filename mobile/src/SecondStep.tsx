// The second step a change to the account asks for while two-step sign-in is on (Account › Two-step sign-in, deleting
// the account): a code from the authenticator app, a recovery code, or a passkey on this phone. The dialogs keep their
// own password field and buttons; this is the part in between, and what their buttons send (twoStep.ts words it).
import { useEffect, useState } from "react";
import { Button } from "react-native-paper";
import { api } from "./api";
import * as pk from "./passkeys";
import { Field } from "./ui";
import { cleanCode, codeReady, usesRecovery, type Step, type Ways } from "./twoStep";
import { t } from "./i18n";

/** The code typed so far, and whether it is a recovery code. */
export function useSecondStep() {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  return { code, setCode, recovery, setRecovery, reset: () => { setCode(""); setRecovery(false); } };
}
export type SecondStepState = ReturnType<typeof useSecondStep>;

/** What the account offers, read from the server while `load` is true; null until known. When it can't be read, the
 *  code field shows (an authenticator code or a recovery code still works). */
export function useStepWays(load: boolean): Ways | null {
  const [ways, setWays] = useState<Ways | null>(null);
  useEffect(() => {
    if (!load) { setWays(null); return; }
    let live = true;
    (async () => {
      let w: Ways = { totp: true, passkey: false };
      try {
        const s = await api<{ enabled: boolean; totp?: boolean }>("GET", "/api/me/2fa");
        const keys = pk.passkeysSupported() ? (await pk.list().catch(() => ({ passkeys: [] as pk.Passkey[] }))).passkeys : [];
        w = { totp: s.totp ?? s.enabled, passkey: keys.some((k) => k.here) };
      } catch { /* the default above */ }
      if (live) setWays(w);
    })();
    return () => { live = false; };
  }, [load]);
  return ways;
}

/** The code field (an authenticator code, or a recovery code) and the switch between the two. */
export function SecondStepFields({ step, ways }: { step: SecondStepState; ways: Ways }) {
  const recovery = usesRecovery(ways, step.recovery);
  const only = !ways.totp && !ways.passkey; // a recovery code is the only way here: nothing to switch to
  return (
    <>
      {recovery ? (
        <Field key="rc" label={t("Recovery code")} value={step.code} onChangeText={(v) => step.setCode(cleanCode(v, true))} autoCapitalize="none" />
      ) : ways.totp ? (
        <Field key="totp" label={t("Code from your authenticator app")} value={step.code} onChangeText={(v) => step.setCode(cleanCode(v, false))} keyboardType="number-pad"
          textContentType="oneTimeCode" autoComplete="one-time-code" importantForAutofill="yes" maxLength={6} />
      ) : null}
      {only ? null : (
        <Button mode="text" compact onPress={() => { step.setRecovery(!step.recovery); step.setCode(""); }} style={{ alignSelf: "flex-start" }}>
          {step.recovery ? (ways.totp ? t("Use the authenticator app") : t("Back")) : t("Use a recovery code")}
        </Button>
      )}
    </>
  );
}

/** Whether the code typed is complete enough to send. */
export const stepReady = (step: SecondStepState, ways: Ways) => codeReady(step.code, usesRecovery(ways, step.recovery));

/** The second step to send: the passkey's answer (Android asks for it now), or the code as typed. */
export async function takeStep(step: SecondStepState, withPasskey: boolean): Promise<Step> {
  return withPasskey ? { passkey: await pk.proofPasskey() } : { code: step.code };
}
