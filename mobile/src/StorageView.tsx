// One account's storage and backup (storage.ts): used against the limit with a bar, what it is taken by, and per
// signed-in device when it last uploaded, with a warning for a phone whose automatic backup seems to have stopped.
// Shown in Account (compact: the person's own) and in Administration › Storage and backup (every account).
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, ProgressBar, Text } from "react-native-paper";
import { useAppTheme } from "./ui";
import { Icon } from "./icons";
import { t, tn } from "./i18n";
import { type AccountStorage, deviceName, foldDevices, lastSeenText, lastUploadText, splitParts, staleText, storageLine, usedShare } from "./storage";

/** A thin bar as the app's other ones (Account, Administration › Server); red from 90 %. */
export function UsageBar({ share }: { share: number }) {
  const th = useAppTheme();
  return <ProgressBar progress={share} color={share > 0.9 ? th.colors.error : th.colors.primary} style={{ height: 5, borderRadius: 3, backgroundColor: th.colors.outlineVariant }} />;
}

export function StorageView({ a, compact = false }: { a: AccountStorage; compact?: boolean }) {
  const th = useAppTheme();
  const share = usedShare(a);
  const parts = splitParts(a.split);
  const muted = { color: th.colors.onSurfaceVariant };
  // a long list of devices (every browser that ever signed in) stays folded: this phone and what needs a look first
  const [open, setOpen] = useState(false);
  const fold = foldDevices(a.devices, open);
  return (
    <View>
      <Text variant="bodyMedium" style={{ marginBottom: 8 }}>{storageLine(a)}</Text>
      {share !== null ? <UsageBar share={share} /> : null}
      {parts.length > 0 ? (compact
        ? <Text variant="bodySmall" style={[muted, { marginTop: 8 }]}>{parts.map((p) => `${p.label} ${p.text}`).join(" · ")}</Text>
        : <View style={{ marginTop: 8 }}>
          {parts.map((p) => (
            <View key={p.key} style={st.row}>
              <Text variant="bodySmall" style={[muted, { flex: 1 }]}>{p.label}</Text>
              <Text variant="bodySmall" style={muted}>{p.text}</Text>
            </View>
          ))}
        </View>) : null}
      {a.devices_hidden ? (
        <Text variant="bodySmall" style={[muted, { marginTop: 8 }]}>{t("The devices of a shared demo account aren't listed.")}</Text>
      ) : fold.shown.map((d) => {
        const stale = staleText(d);
        return (
          <View key={d.id} style={st.device}>
            <View style={st.icon}><Icon name="phone" size={18} color={stale ? th.colors.error : d.current ? th.colors.primary : th.colors.onSurfaceVariant} /></View>
            <View style={{ flex: 1 }}>
              <Text variant="bodyMedium">{deviceName(d) + (d.current ? " · " + t("This phone") : "")}</Text>
              <Text variant="bodySmall" style={muted}>{[d.current ? "" : lastSeenText(d), lastUploadText(d)].filter(Boolean).join(" · ")}</Text>
              {stale ? <Text variant="bodySmall" style={{ color: th.colors.error, fontWeight: "600", marginTop: 2 }}>{stale}</Text> : null}
            </View>
          </View>
        );
      })}
      {!a.devices_hidden && (fold.hidden > 0 || open) && a.devices.length > 3 ? (
        <Button compact mode="text" onPress={() => setOpen(!open)} style={{ alignSelf: "flex-start", marginTop: 6, marginLeft: 20 }}>
          {open ? t("Show fewer devices") : tn(fold.hidden, "Show {n} more device", "Show {n} more devices")}
        </Button>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", paddingVertical: 1 },
  device: { flexDirection: "row", alignItems: "flex-start", marginTop: 10 },
  icon: { width: 28, paddingTop: 1 },
});
