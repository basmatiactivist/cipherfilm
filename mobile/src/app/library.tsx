import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Appbar, Button, Dialog, FAB, Portal, Text } from "react-native-paper";
import { answerOffer, claimOffer, releaseOffer } from "../search/settings";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import N from "../../modules/cf-native/src/CfNativeModule";
import { away } from "../autolock";
import { Gallery } from "../Gallery";
import { NAV_HEIGHT, NavBar } from "../NavBar";
import { Icon } from "../icons";
import { refreshLibrary, useLibrary } from "../libraryStore";
import { setPicked } from "../pending";
import { demoNote, useSession } from "../session";
import { useAppTheme } from "../ui";
import { text } from "../tokens";
import { t } from "../i18n";

/** Android's photo picker, then the same upload screen as sharing. */
async function pick() {
  const uris = await away(() => N.pickMedia());
  if (!uris.length) return;
  setPicked(uris);
  router.push({ pathname: "/share", params: { from: "picker" } });
}

export default function Library() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { items, error, loading } = useLibrary();
  const demo = !!useSession().me?.demo;
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  // once: offer search, which is off until the person turns it on; asked only while this screen is on top (a dialog
  // opened under the Backup screen would show over it)
  const [offer, setOffer] = useState(false);
  const has = !!items?.length;
  useFocusEffect(useCallback(() => {
    let live = true, mine = false;
    if (has) claimOffer().then((yes) => { mine = yes; if (yes && live) setOffer(true); else if (yes) releaseOffer(); }, () => {});
    return () => { live = false; setOffer(false); if (mine) releaseOffer(); };
  }, [has]));
  const answer = (yes: boolean) => {
    setOffer(false);
    answerOffer();
    if (yes) router.push("/search-settings");
  };
  return (
    <View style={{ flex: 1 }}>
      <Portal>
        <Dialog visible={offer} onDismiss={() => answer(false)}>
          <Dialog.Title>{t("Search your photos?")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {t("Find photos by what's in them (\"beach\", \"birthday cake\") and by the people in them. Runs on this phone; the server never sees what your photos show. The models download once from Hugging Face; you see the size first. Change this any time in Account.")}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => answer(false)}>{t("Not now")}</Button>
            <Button onPress={() => answer(true)}>{t("Set up")}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <Gallery
        items={items} error={error} loading={loading} onRefresh={refreshLibrary} bottom={NAV_HEIGHT}
        header={
          <View>
            <Appbar.Header style={{ backgroundColor: th.colors.background }}>
              <Appbar.Content title={t("Photos")} titleStyle={text.page} />
              <Appbar.Action icon="user" accessibilityLabel={t("Account")} onPress={() => router.push("/account")} />
            </Appbar.Header>
            {demo ? <Text variant="labelLarge" style={[st.demo, { backgroundColor: th.colors.primaryContainer, color: th.colors.onPrimaryContainer }]}>{demoNote()}</Text> : null}
          </View>
        }
        empty={<Empty />}
        fab={demo ? undefined : <FAB icon="upload" label={t("Upload")} onPress={pick} accessibilityLabel={t("Upload photos and videos from this phone")}
          style={[st.fab, { right: 16 + inset.right, bottom: 16 + inset.bottom + NAV_HEIGHT, backgroundColor: th.colors.primary }]} color={th.colors.onPrimary} />}
        nav={<NavBar current="library" />}
      />
    </View>
  );
}

function Empty() {
  const th = useAppTheme();
  return (
    <View style={st.empty}>
      <View style={[st.disc, { backgroundColor: th.colors.primaryContainer }]}><Icon name="photos" size={30} color={th.colors.primary} /></View>
      <Text variant="headlineSmall" style={{ textAlign: "center", marginBottom: 8 }}>{t("Nothing here yet")}</Text>
      <Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant, maxWidth: 320 }}>
        {t("Tap Upload, or share photos to Cipherfilm from your gallery. They are encrypted on this phone before upload.")}
      </Text>
      <Button mode="text" onPress={() => refreshLibrary()} style={{ marginTop: 16 }}>{t("Check again")}</Button>
    </View>
  );
}

const st = StyleSheet.create({
  fab: { position: "absolute" },
  demo: { marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  disc: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", marginBottom: 16 },
});
