This is Cipherfilm's Android app: Expo / React Native, with the native work (crypto via libsodium, uploads, backup, search with ONNX Runtime) in the Kotlin module `modules/cf-native`. There is no iOS build. It shares the web client's crypto code (`../web/src/crypto`), so install `web/`'s packages first. Prioritize mobile-first patterns and performance.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

The project uses npm (`package-lock.json`).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npm test                    # unit tests (Vitest)
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run the typecheck and the unit tests (`npm test`, Vitest) before declaring any task done; CI runs both.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building

This project does not use EAS or over-the-air updates. Release builds are made by `.github/workflows/android.yml`: `npx expo prebuild --platform android`, then Gradle (`assembleRelease` for the GitHub APK, `bundleRelease` with `CF_STORE=play` for the Google Play bundle), signed by `plugins/withReleaseSigning` from `CF_KEYSTORE`. `app.config.js` sets the version from `CF_VERSION` and for `CF_STORE=play` drops the battery-exemption permission and the explicit-search switch (search always filtered). Locally: `npx expo run:android`, or `make play-aab VERSION=X.Y.Z` for the Play bundle (docs/RELEASING.md). Test against the throwaway server in `dev/` (`dev/compose.yaml`, `dev/account.mts`), never a real one.

## Rules

- The `android/` directory is generated (Continuous Native Generation) and git-ignored. Never create or edit it by hand — configure native behavior in `app.json`, `app.config.js` and the config plugins in `plugins/`.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:android`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
