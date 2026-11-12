// Small building blocks on top of Material 3 (react-native-paper), in the web app's world.
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Keyboard, KeyboardAvoidingView, ScrollView, StyleSheet, View, type ViewStyle } from "react-native";
import { Dialog as PaperDialog, HelperText, List, Switch, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AppTheme } from "./theme";
import { radius } from "./tokens";

export const useAppTheme = () => useTheme<AppTheme>();

/** The keyboard's height while it is up, else 0. */
export function useKeyboardHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const a = Keyboard.addListener("keyboardDidShow", (e) => setH(e.endCoordinates.height));
    const b = Keyboard.addListener("keyboardDidHide", () => setH(0));
    return () => { a.remove(); b.remove(); };
  }, []);
  return h;
}

/** Paper's Dialog, lifted above the keyboard: with Android's edge-to-edge the window no longer shrinks for it, so a
 *  dialog with a field would keep its buttons under the keyboard. Same parts as Paper's (Dialog.Title, …). */
function LiftedDialog(p: ComponentProps<typeof PaperDialog>) {
  const kb = useKeyboardHeight();
  return <PaperDialog {...p} style={[p.style, kb ? { marginBottom: kb } : null]} />;
}
export const Dialog = Object.assign(LiftedDialog, {
  Title: PaperDialog.Title, Content: PaperDialog.Content, Actions: PaperDialog.Actions, ScrollArea: PaperDialog.ScrollArea, Icon: PaperDialog.Icon,
});

/** A full screen on paper, inside the system bars. `form` scrolls and keeps fields above the keyboard. */
export function Screen({ children, center, form, style }: { children: ReactNode; center?: boolean; form?: boolean; style?: ViewStyle }) {
  const th = useAppTheme();
  const inset = useSafeAreaInsets();
  const pad = { paddingTop: inset.top, paddingBottom: inset.bottom, paddingLeft: inset.left, paddingRight: inset.right };
  if (form) {
    return (
      <KeyboardAvoidingView behavior="padding" style={[s.fill, { backgroundColor: th.colors.background }]}>
        <ScrollView contentContainerStyle={[s.form, pad, { paddingLeft: inset.left + 24, paddingRight: inset.right + 24 }]} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </KeyboardAvoidingView>
    );
  }
  return <View style={[s.fill, pad, { backgroundColor: th.colors.background }, center && s.center, style]}>{children}</View>;
}

/** Serif heading for page and card titles: the web app's "time and place" voice. */
export const Title = ({ children }: { children: ReactNode }) => (
  <Text variant="headlineMedium" accessibilityRole="header" style={s.title}>{children}</Text>
);

export const Lead = ({ children }: { children: ReactNode }) => {
  const th = useAppTheme();
  return <Text variant="bodyLarge" style={[s.lead, { color: th.colors.onSurfaceVariant }]}>{children}</Text>;
};

/** What a screen may do with a field, e.g. move the focus to it from the one before. */
export type FieldHandle = { focus: () => void };

export function Field(props: React.ComponentProps<typeof TextInput> & { hint?: string; inputRef?: { current: FieldHandle | null } }) {
  const { hint, inputRef, ...rest } = props;
  return (
    <View style={s.field}>
      <TextInput mode="outlined" outlineStyle={{ borderRadius: radius.control }} autoCorrect={false} {...rest}
        ref={inputRef ? (r: unknown) => { inputRef.current = r as FieldHandle | null; } : undefined} />
      {hint ? <HelperText type="info" style={s.hint}>{hint}</HelperText> : null}
    </View>
  );
}

/** A setting with a switch: the whole row toggles it, and a screen reader hears one switch with its title and state
 *  (not an unnamed switch next to a row that does nothing). */
export function SwitchItem({ title, description, value, onValueChange, disabled, left, style }: {
  title: string; description?: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean;
  left?: React.ComponentProps<typeof List.Item>["left"];
  /** the list's own item style, so a switch row lines up with the rows around it */
  style?: React.ComponentProps<typeof List.Item>["style"];
}) {
  return (
    <List.Item title={title} description={description} titleNumberOfLines={3} descriptionNumberOfLines={6} left={left} disabled={disabled} style={style}
      onPress={disabled ? undefined : () => onValueChange(!value)} accessibilityRole="switch" accessibilityState={{ checked: value, disabled }}
      right={() => (
        <View importantForAccessibility="no-hide-descendants" style={{ justifyContent: "center" }}>
          <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
        </View>
      )} />
  );
}

/** A problem in plain words, in the brick tint, read out by screen readers when it appears. */
export function Problem({ children }: { children?: ReactNode }) {
  const th = useAppTheme();
  if (!children) return null;
  return (
    <View accessibilityLiveRegion="polite" style={[s.problem, { backgroundColor: th.colors.errorContainer, borderColor: th.colors.error }]}>
      <Text variant="bodyMedium" style={{ color: th.colors.onErrorContainer, fontWeight: "600" }}>{children}</Text>
    </View>
  );
}

/** A centred column no wider than a card, so forms read well on tablets and in landscape too. */
export const Column = ({ children }: { children: ReactNode }) => <View style={s.column}>{children}</View>;

const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  form: { flexGrow: 1, justifyContent: "center" },
  column: { width: "100%", maxWidth: 440, alignSelf: "center", paddingVertical: 32 },
  title: { marginBottom: 8 },
  lead: { marginBottom: 24 },
  field: { marginBottom: 12 },
  hint: { paddingHorizontal: 4 },
  problem: { borderWidth: 1, borderRadius: radius.card, padding: 12, marginBottom: 16 },
});
