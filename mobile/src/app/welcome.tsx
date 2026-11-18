import { useCallback, useState } from "react";
import { BackHandler, ScrollView, StyleSheet, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Button, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "../icons";
import { markIntroSeen } from "../intro";
import { useAppTheme } from "../ui";
import { t } from "../i18n";

/** The short introduction: four pages, one at a time (each scrolls when the text is large), Skip on every page.
 *  Back goes to the page before. Shown once after the first sign-in on this phone (library.tsx), and from Account. */
const pages = (): { icon: IconName; title: string; body: string }[] => [
  { icon: "lock", title: t("Encrypted on this phone"),
    body: t("Photos and videos are encrypted here before they leave the phone. The server only stores encrypted data; only your devices can open it. Make a recovery key in Cipherfilm in the browser: without it, nobody can bring your photos back if you forget your password.") },
  { icon: "cloud", title: t("Back up and upload"),
    body: t("Turn on Backup in Account, and new photos from the folders you choose are backed up on their own. Or tap Upload, or share photos to Cipherfilm from any app. Once they are safe, Free up space removes them from this phone if you like.") },
  { icon: "search", title: t("Search and people"),
    body: t("Search finds photos by what's in them, by people, places and dates, like \"dog beach 2024\". It runs on this phone, so the server never sees what your photos show. Turn it on in Account when you like.") },
  { icon: "fingerprint", title: t("Locked when you leave"),
    body: t("Cipherfilm locks when you leave it for a while; unlock with your password or fingerprint. Two strong shakes lock and close it at once. All of this can be changed in Account.") },
];

export default function Welcome() {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const { again } = useLocalSearchParams<{ again?: string }>();
  const [i, setI] = useState(0);
  const finish = () => {
    markIntroSeen();
    if (again && router.canGoBack()) router.back();
    else router.replace("/library");
  };
  // Back: the page before; on the first page, as from anywhere else
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { if (i > 0) { setI(i - 1); return true; } return false; });
    return () => sub.remove();
  }, [i]));
  const PAGES = pages();
  const page = PAGES[i];
  const last = i === PAGES.length - 1;
  return (
    <View style={[st.fill, { backgroundColor: th.colors.background, paddingTop: inset.top, paddingBottom: inset.bottom + 16, paddingLeft: inset.left, paddingRight: inset.right }]}>
      <View style={st.top}>
        {last ? <View /> : <Button onPress={finish} accessibilityHint={t("Ends the introduction")}>{t("Skip")}</Button>}
      </View>
      <ScrollView key={i} contentContainerStyle={st.page}>
        <View style={[st.disc, { backgroundColor: th.colors.primaryContainer }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Icon name={page.icon} size={34} color={th.colors.primary} />
        </View>
        <Text variant="labelLarge" style={{ color: th.colors.onSurfaceVariant, marginBottom: 8 }}>
          {t("{n} of {total}", { n: i + 1, total: PAGES.length })}
        </Text>
        <Text variant="headlineSmall" accessibilityRole="header" style={st.title}>{page.title}</Text>
        <Text variant="bodyLarge" style={[st.body, { color: th.colors.onSurfaceVariant }]}>{page.body}</Text>
      </ScrollView>
      <View style={st.bottom}>
        <View style={st.dots} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {PAGES.map((p, k) => <View key={p.title} style={[st.dot, { backgroundColor: k === i ? th.colors.primary : th.colors.outlineVariant }]} />)}
        </View>
        <View style={st.actions}>
          {i > 0 ? <Button onPress={() => setI(i - 1)}>{t("Back")}</Button> : <View />}
          <Button mode="contained" contentStyle={{ height: 48, paddingHorizontal: 8 }} onPress={() => (last ? finish() : setI(i + 1))}>
            {last ? t("Get started") : t("Next")}
          </Button>
        </View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1 },
  top: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 8, minHeight: 48 },
  page: { flexGrow: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 32, paddingVertical: 24, maxWidth: 520, alignSelf: "center", width: "100%" },
  disc: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center", marginBottom: 24 },
  title: { textAlign: "center", marginBottom: 12 },
  body: { textAlign: "center" },
  bottom: { paddingHorizontal: 24, gap: 16 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
});
