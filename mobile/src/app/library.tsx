import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Appbar, Button, Dialog, FAB, Portal, Text } from "react-native-paper";
import { claimOffer } from "../search/settings";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N from "../../modules/cf-native/src/CfNativeModule";
import { away } from "../autolock";
import { Gallery } from "../Gallery";
import { NAV_HEIGHT, NavBar } from "../NavBar";
import { Icon } from "../icons";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { setPicked } from "../pending";
import { useAppTheme } from "../ui";
import { text } from "../tokens";

/** Android's photo picker, then the same upload screen as sharing. */
async function pick() {
  const uris = await away(() => N.pickMedia());
  if (!uris.length) return;
  setPicked(uris);
  router.push({ pathname: "/share", params: { from: "picker" } });
}

export default function Library() {
  const t = useAppTheme();
  const inset = useSafeAreaInsets();
  const { items, error, loading } = useLibrary();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  // once: offer search, which is off until the person turns it on (claimOffer saves that it was asked, at once)
  const [offer, setOffer] = useState(false);
  useEffect(() => {
    let live = true;
    if (items?.length) claimOffer().then((yes) => { if (yes && live) setOffer(true); }, () => {});
    return () => { live = false; };
  }, [!!items?.length]);
  const answer = (yes: boolean) => {
    setOffer(false);
    if (yes) router.push("/search-settings");
  };
  return (
    <View style={{ flex: 1 }}>
      <Portal>
        <Dialog visible={offer} onDismiss={() => answer(false)}>
          <Dialog.Title>Search your photos?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              Cipherfilm can find photos by what's in them ("beach", "birthday cake") and group the people in them. It works on this phone with a one-time download of the search models from your own server (the size shows before it starts); the server never sees what your photos show. You can change this any time under Account.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => answer(false)}>Not now</Button>
            <Button onPress={() => answer(true)}>Set up</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <Gallery
        items={items} error={error} loading={loading} onRefresh={refreshLibrary} bottom={NAV_HEIGHT}
        header={
          <Appbar.Header style={{ backgroundColor: t.colors.background }}>
            <Appbar.Content title="Photos" titleStyle={text.page} />
            <Appbar.Action icon="user" accessibilityLabel="Account" onPress={() => router.push("/account")} />
          </Appbar.Header>
        }
        empty={<Empty />}
        fab={<FAB icon="upload" label="Upload" onPress={pick} accessibilityLabel="Upload photos and videos from this phone"
          style={[st.fab, { right: 16 + inset.right, bottom: 16 + inset.bottom + NAV_HEIGHT, backgroundColor: t.colors.primary }]} color={t.colors.onPrimary} />}
        nav={<NavBar current="library" />}
      />
    </View>
  );
}

function Empty() {
  const t = useAppTheme();
  return (
    <View style={st.empty}>
      <View style={[st.disc, { backgroundColor: t.colors.primaryContainer }]}><Icon name="photos" size={30} color={t.colors.primary} /></View>
      <Text variant="headlineSmall" style={{ textAlign: "center", marginBottom: 8 }}>Nothing here yet</Text>
      <Text variant="bodyMedium" style={{ textAlign: "center", color: t.colors.onSurfaceVariant, maxWidth: 320 }}>
        Tap Upload, or share photos from your gallery to Cipherfilm. They are encrypted on this phone before they leave it.
      </Text>
      <Button mode="text" onPress={refreshLibrary} style={{ marginTop: 16 }}>Check again</Button>
    </View>
  );
}

const st = StyleSheet.create({
  fab: { position: "absolute" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  disc: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", marginBottom: 16 },
});
