// Account › Devices: everywhere this account is signed in (what each device calls itself, when it signed in, when it
// was last active), and signing out one that is lost or not yours. A device signed out this way deletes what it keeps
// of the library at its next request.
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, Divider, List, Portal, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { Problem, useAppTheme } from "../ui";
import { Icon } from "../icons";
import { busyIcon } from "../Loader";
import { useAction } from "../useAction";
import { lastActive } from "../notices";
import { text } from "../tokens";
import { locale, t, tn } from "../i18n";

interface Device { id: string; device: string; created_at: number; last_seen: number; current: boolean; indexer: boolean }

const day = (sec: number) => new Date(sec * 1000).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });

export default function Devices() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const [list, setList] = useState<Device[] | null>(null);
  const [ask, setAsk] = useState<Device | "others" | null>(null);
  const page = useAction();
  const act = useAction();
  const load = () => page.run(async () => setList((await api<{ sessions: Device[] }>("GET", "/api/me/sessions")).sessions));
  useEffect(() => { load(); }, []);
  const others = list?.filter((d) => !d.current).length ?? 0;
  const close = () => { if (!act.busy) { setAsk(null); act.setError(undefined); } };
  const signOut = () => act.run(async () => {
    if (ask === "others") await api("POST", "/api/me/sessions/end-others");
    else if (ask) await api("DELETE", `/api/me/sessions/${ask.id}`);
    setAsk(null);
    await load();
  });
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.background }}>
      <Appbar.Header style={{ backgroundColor: th.colors.background }}>
        <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
        <Appbar.Content title={t("Devices")} titleStyle={text.page} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ paddingBottom: inset.bottom + 24 }}>
        <View style={st.block}>
          <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant }}>{t("Where you're signed in. Sign out a device that is lost or isn't yours.")}</Text>
          <Problem>{page.error}</Problem>
        </View>
        <Divider />
        {(list ?? []).map((d) => (
          <List.Item key={d.id} title={d.device || t("Unknown device")} titleNumberOfLines={2} descriptionNumberOfLines={3}
            description={[d.current ? t("This phone") : lastActive(d.last_seen), t("signed in {date}", { date: day(d.created_at) }), d.indexer ? t("indexes your photos for search") : ""].filter(Boolean).join(" · ")}
            left={() => <View style={st.icon}><Icon name="phone" color={d.current ? th.colors.primary : th.colors.onSurfaceVariant} /></View>}
            right={d.current ? undefined : () => <Button compact onPress={() => setAsk(d)}>{t("Sign out")}</Button>}
            style={st.item} />
        ))}
        {others > 1 ? (
          <View style={st.block}>
            <Button mode="outlined" textColor={th.colors.error} onPress={() => setAsk("others")}>{t("Sign out all other devices")}</Button>
          </View>
        ) : null}
      </ScrollView>
      <Portal>
        <Dialog visible={ask !== null} onDismiss={close}>
          <Dialog.Title>{ask === "others" ? tn(others, "Sign out {n} other device?", "Sign out {n} other devices?") : t("Sign out {device}?", { device: (ask && ask.device) || t("this device") })}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("It must sign in again, and deletes what it keeps of your library the next time it reaches the server.")}</Text>
            <Problem>{act.error}</Problem>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={close} disabled={act.busy}>{t("Cancel")}</Button>
            <Button textColor={th.colors.error} onPress={signOut} icon={act.busy ? busyIcon : undefined} disabled={act.busy}>{t("Sign out")}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const st = StyleSheet.create({
  block: { paddingHorizontal: 16, paddingVertical: 16 },
  item: { minHeight: 64, paddingHorizontal: 8 },
  icon: { width: 40, alignItems: "center", justifyContent: "center", marginLeft: 8 },
});
