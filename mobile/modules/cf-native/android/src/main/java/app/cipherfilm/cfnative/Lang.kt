package app.cipherfilm.cfnative

import java.util.Locale

/** Text the native side shows itself (the notification channel, fallbacks): German on a German phone, else English,
 *  like the app's own words (src/i18n.ts). Read each time, so a language change applies from the next notification. */
internal fun de(en: String, de: String): String = if (Locale.getDefault().language == "de") de else en
