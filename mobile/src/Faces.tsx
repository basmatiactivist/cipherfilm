import { memo, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { Text } from "react-native-paper";
import { faceUri, personName, type Group } from "./search/people";
import { Icon } from "./icons";
import { useAppTheme } from "./ui";

/** A person as a round face picture with the name below (or "Add name"), as in Google Photos' people row. */
export const FaceAvatar = memo(function FaceAvatar({ group, size = 72, onPress, count }: { group: Group; size?: number; onPress: () => void; count?: boolean }) {
  const t = useAppTheme();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (group.cover) faceUri(group.cover).then((u) => live && setUri(u), () => {});
    return () => { live = false; };
  }, [group.cover?.key]);
  const name = personName(group);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${name || "Someone not named yet"}, ${group.items.length} photos`} style={{ alignItems: "center", width: size + 16 }}>
      {({ pressed }) => (
        <>
          <View style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden", backgroundColor: t.colors.surfaceVariant, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.8 : 1 }}>
            {uri ? <Image source={{ uri }} style={{ width: size, height: size }} cachePolicy="memory" transition={120} /> : <Icon name="user" size={size / 2.4} color={t.colors.onSurfaceVariant} />}
          </View>
          <Text variant="labelMedium" numberOfLines={1} style={{ marginTop: 6, color: name ? t.colors.onSurface : t.colors.primary }}>{name || "Add name"}</Text>
          {count ? <Text variant="labelSmall" style={{ color: t.colors.onSurfaceVariant }}>{group.items.length}</Text> : null}
        </>
      )}
    </Pressable>
  );
});
