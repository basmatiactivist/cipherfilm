package app.cipherfilm.cfnative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper

/**
 * Automatic lock (src/autolock.ts): a timer that runs while the app is in the background, where React Native's own
 * timers stop, and the screen turning off. Both only tell the JavaScript side ([onDue]), which locks unless an upload
 * is running. The timer counts awake time; the JavaScript side also checks the time away on the monotonic clock when
 * the app comes back, which covers deep sleep and a frozen process.
 */
internal object AutoLock {
  private val handler = Handler(Looper.getMainLooper())
  private val fire = Runnable { onDue?.invoke("timer") }
  var onDue: ((why: String) -> Unit)? = null

  private var receiver: BroadcastReceiver? = null

  fun schedule(ms: Long) { handler.removeCallbacks(fire); handler.postDelayed(fire, ms.coerceAtLeast(0)) }
  fun cancel() { handler.removeCallbacks(fire) }

  /** Registered at runtime only: Android delivers SCREEN_OFF to no receiver in the manifest. */
  @Synchronized fun watchScreen(context: Context, on: Boolean) {
    val app = context.applicationContext
    if (on && receiver == null) {
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) { if (i.action == Intent.ACTION_SCREEN_OFF) onDue?.invoke("screen") }
      }
      app.registerReceiver(r, IntentFilter(Intent.ACTION_SCREEN_OFF))
      receiver = r
    } else if (!on) {
      receiver?.let { runCatching { app.unregisterReceiver(it) } }
      receiver = null
    }
  }
}
