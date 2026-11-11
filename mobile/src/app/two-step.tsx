// Account › Two-step sign-in: turn it on with an authenticator app (the secret as a QR code, made on this phone, and
// as text), see how many recovery codes are left, make new ones, or turn it off. Every change needs the password;
// making new codes and turning it off also need a code. Unlocking this phone never asks for a code.
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, Divider, List, Portal, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path, Rect } from "react-native-svg";
import { encodeQR, qrPath } from "@crypto/qr";
import { api } from "../api";
import { passwordProof, refreshMe, useSession } from "../session";
import { Field, Problem, useAppTheme } from "../ui";
import { Icon } from "../icons";
import { busyIcon } from "../Loader";
import { useAction } from "../useAction";
import { cleanCode, codeReady, groupSecret } from "../twoStep";
import { text } from "../tokens";
import { t, tn } from "../i18n";
import { NoticeAlertsHint } from "../NoticeAlertsSetting";

interface Status { enabled: boolean; recovery_codes_left: number; available: boolean }
interface Setup { secret: string; uri: string }
/** What the password dialog is for: starting the setup, new recovery codes, turning it off. */
type Ask = "setup" | "codes" | "off" | null;

export default function TwoStep() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { me } = useSession();
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const page = useAction();
  const dialog = useAction();
  const load = () => page.run(async () => setStatus(await api<Status>("GET", "/api/me/2fa")));
  useEffect(() => { load(); }, []);
  const demo = !!me?.demo || status?.available === false;

  const closeAsk = () => { if (!dialog.busy) { setAsk(null); setPassword(""); setCode(""); setRecovery(false); dialog.setError(undefined); } };
  const confirm = () => dialog.run(async () => {
    const auth = await passwordProof(password);
    if (ask === "setup") {
      setSetup(await api<Setup>("POST", "/api/me/2fa/setup", { current_auth: auth }));
    } else if (ask === "codes") {
      setCodes((await api<{ recovery_codes: string[] }>("POST", "/api/me/2fa/recovery-codes", { current_auth: auth, code })).recovery_codes);
    } else if (ask === "off") {
      await api("POST", "/api/me/2fa/disable", { current_auth: auth, code });
      await refreshMe().catch(() => null);
    }
    setAsk(null); setPassword(""); setCode(""); setRecovery(false);
    if (ask !== "setup") await load();
  });
  const enable = () => page.run(async () => {
    const r = await api<{ recovery_codes: string[] }>("POST", "/api/me/2fa/enable", { code });
    setCode("");
    setSetup(null);
    setCodes(r.recovery_codes);
    await refreshMe().catch(() => null);
    await load();
  });

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => { if (setup) setSetup(null); else router.back(); }} />
        <Appbar.Content title={t("Two-step sign-in")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <View style={st.block}>
          <Problem>{page.error}</Problem>
          {codes ? <Codes codes={codes} onDone={() => setCodes(null)} />
            : setup ? (
              <SetupView setup={setup} code={code} setCode={setCode} busy={page.busy} onEnable={enable} />
            ) : demo ? (
              <Text variant="bodyMedium">{t("Not available in the public demo.")}</Text>
            ) : !status ? null : status.enabled ? (
              <>
                <Text variant="bodyMedium">{t("On. A new sign-in asks for a code from your authenticator app after the password. Unlocking this phone doesn't.")}</Text>
                <Text variant="bodyMedium" style={{ marginTop: 12, color: status.recovery_codes_left < 3 ? th.colors.error : th.colors.onSurfaceVariant }}>
                  {tn(status.recovery_codes_left, "{n} recovery code left", "{n} recovery codes left")}
                </Text>
                {/* a sign-in with a stolen password is told by notifications too: why and how to allow them */}
                <View style={{ marginTop: 12, marginHorizontal: -16 }}><NoticeAlertsHint /></View>
              </>
            ) : (
              <Text variant="bodyMedium">{t("Off. Turn it on, and a new sign-in also needs a code from an authenticator app on your phone, so a stolen password alone isn't enough.")}</Text>
            )}
        </View>
        {!codes && !setup && !demo && status ? (
          <>
            <Divider />
            {status.enabled ? (
              <>
                <List.Item title={t("New recovery codes")} description={t("The old ones stop working")} left={() => <View style={st.icon}><Icon name="key" color={th.colors.primary} /></View>}
                  onPress={() => setAsk("codes")} style={st.item} />
                <List.Item title={t("Turn off two-step sign-in")} titleStyle={{ color: th.colors.error }} description={t("The password alone signs in again")}
                  left={() => <View style={st.icon}><Icon name="lock" color={th.colors.error} /></View>} onPress={() => setAsk("off")} style={st.item} />
              </>
            ) : (
              <List.Item title={t("Turn on two-step sign-in")} description={t("You need an authenticator app")} left={() => <View style={st.icon}><Icon name="lock" color={th.colors.primary} /></View>}
                onPress={() => setAsk("setup")} style={st.item} />
            )}
          </>
        ) : null}
      </ScrollView>
      <Portal>
        <Dialog visible={ask !== null} onDismiss={closeAsk}>
          <Dialog.Title>{ask === "off" ? t("Turn off two-step sign-in?") : ask === "codes" ? t("New recovery codes") : t("Enter your password")}</Dialog.Title>
          <Dialog.Content>
            <Field label={t("Password")} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" autoFocus
              hint={dialog.busy ? t("Checking your password…") : undefined} />
            {ask !== "setup" ? (
              <>
                {recovery ? (
                  <Field key="rc" label={t("Recovery code")} value={code} onChangeText={(v) => setCode(cleanCode(v, true))} autoCapitalize="none" />
                ) : (
                  <Field key="totp" label={t("Code from your authenticator app")} value={code} onChangeText={(v) => setCode(cleanCode(v, false))} keyboardType="number-pad"
                    textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} />
                )}
                <Button mode="text" compact onPress={() => { setRecovery(!recovery); setCode(""); }} style={{ alignSelf: "flex-start" }}>
                  {recovery ? t("Use the authenticator app") : t("Use a recovery code")}
                </Button>
              </>
            ) : null}
            <Problem>{dialog.error}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeAsk} disabled={dialog.busy}>{t("Cancel")}</Button>
            <Button onPress={confirm} icon={dialog.busy ? busyIcon : undefined} textColor={ask === "off" ? th.colors.error : undefined}
              disabled={dialog.busy || !password || (ask !== "setup" && !codeReady(code, recovery))}>
              {ask === "off" ? t("Turn off") : t("Continue")}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

function SetupView({ setup, code, setCode, busy, onEnable }: { setup: Setup; code: string; setCode: (s: string) => void; busy: boolean; onEnable: () => void }) {
  const th = useAppTheme();
  const qr = useMemo(() => encodeQR(setup.uri), [setup.uri]);
  const side = qr.size + 8; // with the quiet zone of four modules each side
  return (
    <>
      <Text variant="bodyMedium">{t("1. In your authenticator app, add an account and scan this code.")}</Text>
      {/* always dark on white: scanners expect it, also in dark mode */}
      <View style={st.qr} accessible accessibilityLabel={t("QR code for your authenticator app")}>
        <Svg width={232} height={232} viewBox={`0 0 ${side} ${side}`}>
          <Rect x={0} y={0} width={side} height={side} fill="#ffffff" />
          <Path d={qrPath(qr)} fill="#000000" />
        </Svg>
      </View>
      <Text variant="bodyMedium">{t("Can't scan it? Enter this key instead (time-based):")}</Text>
      <Text variant="titleMedium" selectable style={[st.secret, { backgroundColor: th.colors.surfaceVariant }]}>{groupSecret(setup.secret)}</Text>
      <Text variant="bodyMedium" style={{ marginTop: 16, marginBottom: 8 }}>{t("2. Enter the 6-digit code the app shows.")}</Text>
      <Field label={t("Code")} value={code} onChangeText={(v) => setCode(cleanCode(v, false))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code"
        maxLength={6} returnKeyType="go" onSubmitEditing={() => { if (codeReady(code, false)) onEnable(); }} />
      <Button mode="contained" onPress={onEnable} icon={busy ? busyIcon : undefined} disabled={busy || !codeReady(code, false)} contentStyle={{ height: 48 }}>{t("Turn on")}</Button>
    </>
  );
}

function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const th = useAppTheme();
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Text variant="titleMedium">{t("Save your recovery codes")}</Text>
      <Text variant="bodyMedium" style={{ marginTop: 8 }}>
        {t("If you lose your phone, each code signs you in once instead of the authenticator app. Keep them somewhere safe, like a password manager. They are shown only now.")}
      </Text>
      <View style={[st.codes, { backgroundColor: th.colors.surfaceVariant }]}>
        {codes.map((c) => <Text key={c} variant="titleMedium" selectable style={st.code}>{c}</Text>)}
      </View>
      <Button mode={saved ? "contained" : "outlined"} icon={saved ? "check" : undefined} onPress={() => setSaved(true)} style={{ marginBottom: 8 }}>{t("I saved them")}</Button>
      <Button mode="contained" onPress={onDone} disabled={!saved} contentStyle={{ height: 48 }}>{t("Done")}</Button>
    </>
  );
}

const st = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingVertical: 16 },
  item: { minHeight: 64, paddingHorizontal: 8 },
  icon: { width: 40, alignItems: "center", justifyContent: "center", marginLeft: 8 },
  qr: { alignSelf: "center", marginVertical: 16, padding: 0, borderRadius: 8, overflow: "hidden" },
  secret: { fontFamily: "monospace", padding: 12, borderRadius: 8, marginTop: 8, textAlign: "center", letterSpacing: 1 },
  codes: { borderRadius: 8, padding: 16, marginVertical: 16, alignItems: "center" },
  code: { fontFamily: "monospace", marginVertical: 2, letterSpacing: 1 },
});
