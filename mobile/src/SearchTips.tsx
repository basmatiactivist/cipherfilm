// "How search works": what the one search box understands (docs/SEARCH.md "Combined search"), from the Search screen
// and when nothing was found. Nothing needs tagging: search reads the photos themselves.
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Portal, Text } from "react-native-paper";
import { Dialog, useAppTheme } from "./ui";
import { t } from "./i18n";

const tips = (): [string, string][] => [
  [t("What's in a photo"), t("\"dog\", \"birthday cake\", \"sunset at the beach\". Needs search turned on; English works best, common German words work too.")],
  [t("People"), t("The name you gave someone under People, or one word of it.")],
  [t("Places"), t("A town, region or country where photos were taken: \"rome\", \"switzerland\".")],
  [t("Dates"), t("\"2023\", \"may 2023\", \"from 2019 to 2021\", \"christmas\", \"last year\".")],
  [t("Kinds"), t("\"favorites\", \"videos\", \"screenshots\".")],
  [t("Text in photos"), t("Words on signs, menus or documents, once Text in photos is on.")],
  [t("Combine them"), t("\"anna rome 2024 dog\": every part must match. Each part that was understood shows as a chip under the box; × takes it out.")],
  [t("Photos like this one"), t("Open a photo's details and tap Photos like this one.")],
];

export function SearchTips({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const th = useAppTheme();
  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onClose} style={{ maxHeight: "85%" }}>
        <Dialog.Title>{t("How search works")}</Dialog.Title>
        <Dialog.ScrollArea style={{ paddingHorizontal: 0 }}>
          <ScrollView contentContainerStyle={st.list}>
            <Text variant="bodyMedium" style={{ marginBottom: 16 }}>
              {t("No tagging needed: search looks at the photos themselves, on this phone. The server never sees what they show.")}
            </Text>
            {tips().map(([head, body]) => (
              <View key={head} style={st.tip} accessible>
                <Text variant="titleSmall">{head}</Text>
                <Text variant="bodyMedium" style={{ color: th.colors.onSurfaceVariant }}>{body}</Text>
              </View>
            ))}
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          <Button onPress={onClose}>{t("Done")}</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const st = StyleSheet.create({
  list: { paddingHorizontal: 24, paddingVertical: 16 },
  tip: { marginBottom: 14, gap: 2 },
});
