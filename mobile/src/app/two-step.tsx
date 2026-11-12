// Account › Two-step sign-in: turn it on with an authenticator app (added with one tap, or the secret as a QR code,
// made on this phone, and as text) or a passkey (Credential Manager, passkeys.ts), see how many recovery codes are
// left, make new ones, remove a passkey or the app, or turn it off. Every change needs the password; while it is on,
// a second step too (a code, a recovery code or a passkey). Unlocking this phone never asks for one.
import { useEffect, useMemo, useState } from "react";
import { Linking, ScrollView, Share, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, Divider, List, Portal, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path, Rect } from "react-native-svg";
import { encodeQR, qrPath } from "@crypto/qr";
import N from "../../modules/cf-native/src/CfNativeModule";
import { api } from "../api";
import { passwordProof, refreshMe, useSession } from "../session";
import * as pk from "../passkeys";
import { Field, Problem, useAppTheme } from "../ui";
import { Icon } from "../icons";
import { busyIcon } from "../Loader";
import { useAction } from "../useAction";
import { cleanCode, codeReady, groupSecret, stepButtons, stepError, stepNeeded, withStep, type Ways } from "../twoStep";
import { SecondStepFields, stepReady, takeStep, useSecondStep } from "../SecondStep";
import { text } from "../tokens";
import { t, tn } from "../i18n";
import { NoticeAlertsHint } from "../NoticeAlertsSetting";

/** totp, passkeys: what the account has (an older server leaves them out: then "enabled" means the app). */
interface Status { enabled: boolean; recovery_codes_left: number; available: boolean; totp?: boolean; passkeys?: number }
interface Setup { secret: string; uri: string }
/** What the password dialog is for. */
type Ask = "setup" | "codes" | "off" | "addkey" | "removeapp" | { remove: pk.Passkey } | null;

export default function TwoStep() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { me } = useSession();
  const [status, setStatus] = useState<Status | null>(null);
  const [keys, setKeys] = useState<pk.Passkey[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState(""); // the code of the authenticator app being set up
  const step = useSecondStep();
  const [name, setName] = useState("");
  const page = useAction();
  const dialog = useAction();
  const load = () => page.run(async () => {
    setStatus(await api<Status>("GET", "/api/me/2fa"));
    setKeys((await pk.list().catch(() => ({ passkeys: [] as pk.Passkey[] }))).passkeys);
  });
  useEffect(() => { load(); }, []);
  const demo = !!me?.demo || status?.available === false;
  const on = !!status?.enabled;
  const totp = status?.totp ?? on;
  const canPasskey = pk.passkeysSupported();
  const ways: Ways = { totp, passkey: canPasskey && keys.some((k) => k.here) };
  // while two-step sign-in is on, every change also needs a second step (setting it up the first time doesn't)
  const second = ask !== null && on;
  const buttons = stepButtons(ways, step.recovery);

  const closeAsk = () => { if (!dialog.busy) { setAsk(null); setPassword(""); step.reset(); dialog.setError(undefined); } };
  const showCodes = (c: string[] | null | undefined) => { if (c && c.length) setCodes(c); };
  const confirm = (withPasskey: boolean) => dialog.run(async () => {
    const proof: pk.Proof = withStep({ current_auth: await passwordProof(password) }, second ? await takeStep(step, withPasskey) : null);
    try {
      await change(proof);
    } catch (e) {
      // two-step sign-in was turned on elsewhere meanwhile: the dialog asks for the second step now
      if (stepNeeded(e)) await load();
      throw stepError(e);
    }
    setAsk(null); setPassword(""); step.reset();
    if (ask !== "setup") { await refreshMe().catch(() => null); await load(); }
  });
  const change = async (proof: pk.Proof) => {
    if (ask === "setup") {
      setSetup(await api<Setup>("POST", "/api/me/2fa/setup", proof));
      setCode("");
    } else if (ask === "codes") {
      setCodes((await api<{ recovery_codes: string[] }>("POST", "/api/me/2fa/recovery-codes", proof)).recovery_codes);
    } else if (ask === "off") {
      await api("POST", "/api/me/2fa/disable", proof);
    } else if (ask === "removeapp") {
      await api("POST", "/api/me/2fa/totp/remove", proof);
    } else if (ask === "addkey") {
      showCodes(await pk.add(proof, name.trim() || t("Passkey on this phone")));
    } else if (ask && typeof ask === "object") {
      await pk.remove(ask.remove.id, proof);
    }
  };
  const enable = () => page.run(async () => {
    const r = await api<{ recovery_codes?: string[] }>("POST", "/api/me/2fa/enable", { code });
    setCode("");
    setSetup(null);
    showCodes(r.recovery_codes);
    await refreshMe().catch(() => null);
    await load();
  });
  const methods = [totp ? t("a code from your authenticator app") : "", keys.length ? t("a passkey") : ""].filter(Boolean).join(t(" or "));
  const title = ask === "off" ? t("Turn off two-step sign-in?") : ask === "codes" ? t("New recovery codes") : ask === "addkey" ? t("Add a passkey")
    : ask === "removeapp" ? t("Remove the authenticator app?") : ask && typeof ask === "object" ? t("Remove {name}?", { name: ask.remove.name }) : t("Enter your password");
  const danger = ask === "off" || ask === "removeapp" || (!!ask && typeof ask === "object");

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
            ) : !status ? null : on ? (
              <>
                <Text variant="bodyMedium">{t("On. A new sign-in asks for {methods} after the password. Unlocking this phone doesn't.", { methods })}</Text>
                <Text variant="bodyMedium" style={{ marginTop: 12, color: status.recovery_codes_left < 3 ? th.colors.error : th.colors.onSurfaceVariant }}>
                  {tn(status.recovery_codes_left, "{n} recovery code left", "{n} recovery codes left")}
                </Text>
                {/* a sign-in with a stolen password is told by notifications too: why and how to allow them */}
                <View style={{ marginTop: 12, marginHorizontal: -16 }}><NoticeAlertsHint /></View>
              </>
            ) : (
              <Text variant="bodyMedium">{t("Off. Turn it on, and a new sign-in also needs a code from an authenticator app or a passkey, so a stolen password alone isn't enough. Your password still unlocks your photos.")}</Text>
            )}
        </View>
        {!codes && !setup && !demo && status ? (
          <>
            <Divider />
            {on ? (
              <>
                <List.Subheader>{t("Authenticator app")}</List.Subheader>
                {totp ? (
                  <List.Item title={t("Authenticator app")} description={keys.length ? t("On. Tap to remove it; the passkeys stay.") : t("On")}
                    left={() => <View style={st.icon}><Icon name="phone" color={th.colors.primary} /></View>}
                    onPress={keys.length ? () => setAsk("removeapp") : undefined} style={st.item} />
                ) : (
                  <List.Item title={t("Add an authenticator app")} description={t("A code from the app as another second step")}
                    left={() => <View style={st.icon}><Icon name="plus" color={th.colors.primary} /></View>} onPress={() => setAsk("setup")} style={st.item} />
                )}
                <List.Subheader>{t("Passkeys")}</List.Subheader>
                {keys.map((k) => (
                  <List.Item key={k.id} title={k.name}
                    description={(k.last_used_at ? t("Last used {date}", { date: new Date(k.last_used_at * 1000).toLocaleDateString() }) : t("Not used yet")) + (k.here ? "" : ` · ${k.rp_id}`)}
                    left={() => <View style={st.icon}><Icon name="key" color={th.colors.primary} /></View>}
                    right={() => <View style={st.icon}><Icon name="trash" color={th.colors.onSurfaceVariant} /></View>}
                    onPress={() => setAsk({ remove: k })} style={st.item} accessibilityHint={t("Remove")} />
                ))}
                {canPasskey ? (
                  <List.Item title={t("Add a passkey")} description={t("From your password manager or a security key")}
                    left={() => <View style={st.icon}><Icon name="plus" color={th.colors.primary} /></View>} onPress={() => { setName(t("Passkey on this phone")); setAsk("addkey"); }} style={st.item} />
                ) : !keys.length ? <Text variant="bodySmall" style={st.note}>{t("Passkeys need Android 14 or newer.")}</Text> : null}
                <List.Subheader>{t("Recovery codes")}</List.Subheader>
                <List.Item title={t("New recovery codes")} description={t("The old ones stop working")} left={() => <View style={st.icon}><Icon name="key" color={th.colors.primary} /></View>}
                  onPress={() => setAsk("codes")} style={st.item} />
                <List.Item title={t("Turn off two-step sign-in")} titleStyle={{ color: th.colors.error }} description={t("The password alone signs in again")}
                  left={() => <View style={st.icon}><Icon name="lock" color={th.colors.error} /></View>} onPress={() => setAsk("off")} style={st.item} />
              </>
            ) : (
              <>
                <List.Item title={t("Turn on with an authenticator app")} description={t("Aegis, 2FAS, Bitwarden, Google Authenticator…")} left={() => <View style={st.icon}><Icon name="lock" color={th.colors.primary} /></View>}
                  onPress={() => setAsk("setup")} style={st.item} />
                {canPasskey ? (
                  <List.Item title={t("Turn on with a passkey")} description={t("From your password manager or a security key")} left={() => <View style={st.icon}><Icon name="key" color={th.colors.primary} /></View>}
                    onPress={() => { setName(t("Passkey on this phone")); setAsk("addkey"); }} style={st.item} />
                ) : null}
              </>
            )}
          </>
        ) : null}
      </ScrollView>
      <Portal>
        <Dialog visible={ask !== null} onDismiss={closeAsk}>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Content>
            {ask === "removeapp" ? <Text variant="bodyMedium" style={{ marginBottom: 8 }}>{t("A new sign-in then asks for a passkey (or a recovery code).")}</Text> : null}
            {ask && typeof ask === "object" && keys.length === 1 && !totp ? <Text variant="bodyMedium" style={{ marginBottom: 8 }}>{t("It's your only second step: two-step sign-in turns off.")}</Text> : null}
            {ask === "addkey" ? <Field label={t("Name")} value={name} onChangeText={setName} maxLength={64} /> : null}
            <Field label={t("Password")} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="current-password" autoFocus={ask !== "addkey"}
              hint={dialog.busy ? t("Checking your password…") : undefined} />
            {second ? <SecondStepFields step={step} ways={ways} /> : null}
            <Problem>{dialog.error}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeAsk} disabled={dialog.busy}>{t("Cancel")}</Button>
            {second && buttons.passkey ? (
              <Button onPress={() => confirm(true)} disabled={dialog.busy || !password}>{t("Use a passkey")}</Button>
            ) : null}
            {!second || buttons.code ? (
              <Button onPress={() => confirm(false)} icon={dialog.busy ? busyIcon : undefined} textColor={danger ? th.colors.error : undefined}
                disabled={dialog.busy || !password || (second && !stepReady(step, ways))}>
                {ask === "off" ? t("Turn off") : danger ? t("Remove") : t("Continue")}
              </Button>
            ) : null}
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
  const [note, setNote] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  // the authenticator app is on this phone: the otpauth: address hands it the account in one tap (Aegis, 2FAS,
  // Bitwarden, Google Authenticator, Proton Pass… register for it); the QR code and the key stay for anything else
  const addToApp = async () => {
    setNote(undefined);
    try {
      await Linking.openURL(setup.uri);
    } catch {
      setNote(t("No app on this phone takes it. Install an authenticator app, or copy the key into one."));
    }
  };
  const copyKey = () => {
    N.copySecret(t("Authenticator key"), setup.secret); // marked sensitive, gone from the clipboard after a minute
    setCopied(true);
  };
  return (
    <>
      <Text variant="bodyMedium">{t("1. Add Cipherfilm to your authenticator app or password manager.")}</Text>
      <Button mode="contained" icon={() => <Icon name="plus" color={th.colors.onPrimary} size={20} />} onPress={addToApp} style={{ marginTop: 12 }} contentStyle={{ height: 48 }}>
        {t("Add to authenticator app")}
      </Button>
      <Problem>{note}</Problem>
      <Text variant="bodyMedium" style={{ marginTop: 16 }}>{t("Or, with an app on another device, scan this code:")}</Text>
      {/* always dark on white: scanners expect it, also in dark mode */}
      <View style={st.qr} accessible accessibilityLabel={t("QR code for your authenticator app")}>
        <Svg width={232} height={232} viewBox={`0 0 ${side} ${side}`}>
          <Rect x={0} y={0} width={side} height={side} fill="#ffffff" />
          <Path d={qrPath(qr)} fill="#000000" />
        </Svg>
      </View>
      <Text variant="bodyMedium">{t("Can't scan it? Enter this key instead (time-based):")}</Text>
      <Text variant="titleMedium" selectable style={[st.secret, { backgroundColor: th.colors.surfaceVariant }]}>{groupSecret(setup.secret)}</Text>
      <Button mode="outlined" icon={copied ? "check" : undefined} onPress={copyKey} style={{ marginTop: 8, alignSelf: "center" }}>{copied ? t("Copied for a minute") : t("Copy key")}</Button>
      <Text variant="bodyMedium" style={{ marginTop: 16, marginBottom: 8 }}>{t("2. Enter the 6-digit code the app shows.")}</Text>
      <Field label={t("Code")} value={code} onChangeText={(v) => setCode(cleanCode(v, false))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code"
        importantForAutofill="yes" maxLength={6} returnKeyType="go" onSubmitEditing={() => { if (codeReady(code, false)) onEnable(); }} />
      <Button mode="contained" onPress={onEnable} icon={busy ? busyIcon : undefined} disabled={busy || !codeReady(code, false)} contentStyle={{ height: 48 }}>{t("Turn on")}</Button>
    </>
  );
}

function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const th = useAppTheme();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const all = codes.join("\n");
  return (
    <>
      <Text variant="titleMedium">{t("Save your recovery codes")}</Text>
      <Text variant="bodyMedium" style={{ marginTop: 8 }}>
        {t("If you lose your phone, each code signs you in once instead of the authenticator app or a passkey. Keep them somewhere safe, like a password manager. They are shown only now.")}
      </Text>
      <View style={[st.codes, { backgroundColor: th.colors.surfaceVariant }]}>
        {codes.map((c) => <Text key={c} variant="titleMedium" selectable style={st.code}>{c}</Text>)}
      </View>
      <View style={st.row}>
        <Button mode="outlined" icon={copied ? "check" : undefined} onPress={() => { N.copySecret(t("Recovery codes"), all); setCopied(true); }} style={st.half}>
          {copied ? t("Copied for a minute") : t("Copy")}
        </Button>
        {/* to a password manager or notes app the person picks; nothing goes anywhere without that choice */}
        <Button mode="outlined" icon={() => <Icon name="share" color={th.colors.primary} size={18} />} style={st.half}
          onPress={() => { Share.share({ message: t("Cipherfilm recovery codes") + "\n\n" + all }).catch(() => {}); }}>{t("Share")}</Button>
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
  note: { paddingHorizontal: 24, paddingBottom: 8 },
  qr: { alignSelf: "center", marginVertical: 16, padding: 0, borderRadius: 8, overflow: "hidden" },
  secret: { fontFamily: "monospace", padding: 12, borderRadius: 8, marginTop: 8, textAlign: "center", letterSpacing: 1 },
  codes: { borderRadius: 8, padding: 16, marginVertical: 16, alignItems: "center" },
  code: { fontFamily: "monospace", marginVertical: 2, letterSpacing: 1 },
  row: { flexDirection: "row", gap: 8, marginBottom: 8 },
  half: { flex: 1 },
});
