// "Tinte und Papier" (DESIGN.md) carried into Material 3: warm paper, ink, one deep teal. Dark is its own scheme,
// ink-blue night paper with a lighter teal, not an inversion. The values come from tokens.ts, generated from
// design/tokens/tokens.json like the web's CSS and the Mac's Ink; here they only become Material roles.
import { MD3DarkTheme, MD3LightTheme, configureFonts, type MD3Theme } from "react-native-paper";
import { dark, light, radius, text, type Palette } from "./tokens";

export { dark, light, type Palette };

const fonts = configureFonts({
  config: {
    headlineMedium: text.auth,
    headlineSmall: text.dialog,
    // titleMedium/body/label stay the system sans (Roboto): the serif is for time and place only
  },
});

export function paperTheme(p: Palette, isDark: boolean): MD3Theme & { cf: Palette } {
  const base = isDark ? MD3DarkTheme : MD3LightTheme;
  return {
    ...base,
    roundness: radius.control / 3, // Paper multiplies this: 6 dp controls, 8-12 dp cards, the web's small corners
    fonts,
    cf: p,
    colors: {
      ...base.colors,
      primary: p.teal,
      onPrimary: p.onTeal,
      primaryContainer: p.tealTint,
      onPrimaryContainer: p.tealInk,
      secondary: p.tealInk,
      onSecondary: p.onTeal,
      secondaryContainer: p.tealTint,
      onSecondaryContainer: p.tealInk,
      // no second accent (the One Teal Rule): "tertiary" is a quiet neutral, for states that are neither ok nor wrong
      tertiary: p.muted,
      onTertiary: p.paper,
      tertiaryContainer: p.paperDeep,
      onTertiaryContainer: p.ink,
      background: p.paper,
      onBackground: p.ink,
      surface: p.paper,
      onSurface: p.ink,
      surfaceVariant: p.paperDeep,
      onSurfaceVariant: p.muted,
      surfaceDisabled: p.paperDeep,
      onSurfaceDisabled: p.faint,
      outline: p.ruleStrong,
      outlineVariant: p.rule,
      error: p.danger,
      onError: p.onDanger,
      errorContainer: p.dangerTint,
      onErrorContainer: p.danger,
      inverseSurface: p.ink,
      inverseOnSurface: p.paper,
      inversePrimary: isDark ? light.teal : dark.teal,
      backdrop: p.backdrop,
      elevation: {
        level0: "transparent",
        level1: p.card,
        level2: p.card,
        level3: p.paperDeep,
        level4: p.paperDeep,
        level5: p.paperDeep,
      },
    },
  };
}

export type AppTheme = ReturnType<typeof paperTheme>;
