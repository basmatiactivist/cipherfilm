// Account's switch for notices as notifications (noticeCheck.ts), and, on Devices, why Android should allow them. The
// permission is asked for when the person turns them on or taps "Allow", never on its own.
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, List, Text } from "react-native-paper";
import N from "../modules/cf-native/src/CfNativeModule";
import { scheduleBackground } from "./backup";
import { setNoticeAlerts, useNoticeAlerts } from "./noticeCheck";
import { requestNotifications } from "./mediaAccess";
import { useOnReturn } from "./deviceState";
import { SwitchItem, useAppTheme } from "./ui";
import { Icon } from "./icons";
import { useSession } from "./session";
import { t } from "./i18n";

const allowedNow = () => { try { return N.noticesAllowed(); } catch { return false; } };

function useAllowed(): [boolean, () => Promise<void>] {
  const [allowed, setAllowed] = useState(allowedNow);
  useOnReturn(() => setAllowed(allowedNow())); // back from Android's settings
  const ask = async () => { await requestNotifications(allowedNow); setAllowed(allowedNow()); };
  return [allowed, ask];
}

export function NoticeAlertsSwitch({ style, iconStyle }: { style: object; iconStyle: object }) {
  const th = useAppTheme();
  const on = useNoticeAlerts();
  const [allowed, ask] = useAllowed();
  const change = (v: boolean) => {
    setNoticeAlerts(v);
    scheduleBackground().catch(() => {});
    if (v && !allowedNow()) ask();
  };
  return (
    <>
      <SwitchItem title={t("Security notifications")}
        description={!on ? t("Off: you see new sign-ins only when you open Cipherfilm") : allowed ? t("A notification when your account is signed in somewhere else, also while Cipherfilm is closed") : t("On, but Android doesn't allow Cipherfilm's notifications yet")}
        left={() => <View style={iconStyle}><Icon name="shield" color={th.colors.primary} /></View>}
        value={on} onValueChange={change} style={style} />
      {on && !allowed ? <List.Item title={t("Allow notifications")} titleStyle={{ color: th.colors.primary }} onPress={ask} style={style}
        left={() => <View style={iconStyle} />} /> : null}
    </>
  );
}

/** On Devices, while they are on but not allowed: why, and the way to allow them. */
export function NoticeAlertsHint() {
  const th = useAppTheme();
  const on = useNoticeAlerts();
  const [allowed, ask] = useAllowed();
  const demo = !!useSession().me?.demo; // a public demo login gets no notices
  if (!on || allowed || demo) return null;
  return (
    <View style={st.box}>
      <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant }}>
        {t("Allow notifications, and this phone tells you when your account is signed in on another device, even while Cipherfilm is closed. The lock screen only says \"New sign-in to Cipherfilm\".")}
      </Text>
      <Button mode="text" compact style={{ alignSelf: "flex-start", marginTop: 4 }} onPress={ask}>{t("Allow")}</Button>
    </View>
  );
}

const st = StyleSheet.create({ box: { paddingHorizontal: 16, paddingBottom: 12 } });
