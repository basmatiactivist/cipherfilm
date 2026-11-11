package app.cipherfilm.cfnative

import android.app.Activity
import android.content.Context
import android.os.Build
import android.view.WindowManager

/**
 * Screenshots, screen recordings and the recent-apps preview: blocked (FLAG_SECURE, the app switcher shows the icon)
 * unless the person allows them in Account. The choice is this phone's, kept in the app's private preferences, so it
 * is known natively before any JavaScript runs: the window is protected in the activity's onCreate, before its first
 * frame (CfNativePackage), and again whenever it comes to the front (CfNativeModule). The lock and unlock screens are
 * in the same window, so they follow the same choice.
 */
object ScreenGuard {
  private const val PREFS = "cf_screen"
  private const val KEY = "allowScreenshots"

  /** Test builds only: `adb shell setprop debug.cipherfilm.shots 1` allows screenshots for the e2e captures. */
  private fun debugShots(): Boolean = BuildConfig.TEST_BUILD &&
    runCatching { Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, "debug.cipherfilm.shots") == "1" }.getOrDefault(false)

  fun allowed(ctx: Context): Boolean =
    runCatching { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false) }.getOrDefault(false)

  /** Stores the choice (synchronously, so a crash right after can't lose a switch back to "blocked") and applies it. */
  fun set(ctx: Context, activity: Activity?, allow: Boolean) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, allow).commit()
    apply(activity)
  }

  /** Sets or clears FLAG_SECURE on the activity's window to match the stored choice; on the UI thread. */
  fun apply(activity: Activity?) {
    activity ?: return
    val open = allowed(activity) || debugShots()
    activity.runOnUiThread {
      if (open) activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      else activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      if (Build.VERSION.SDK_INT >= 33) activity.setRecentsScreenshotEnabled(open)
    }
  }
}
