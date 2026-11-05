package app.cipherfilm.cfnative

import android.content.Context
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/**
 * React Native stops JS timers once the app leaves the screen, unless a headless JS task is running. An upload that
 * started in the app and goes on in TransferService would then hang at its first setTimeout (a retry's wait, a
 * request's time limit) until the app is opened again. While an upload runs, a headless task keeps the timers going
 * (expo-task-manager starts one for its background runs too, but its JS side ends it at once). The JS side of this
 * one (src/backup.ts) waits until letGo.
 */
internal object JsTimers {
  const val TASK = "cipherfilm-keep-timers"
  private val tasks = mutableMapOf<String, MutableList<Int>>()

  fun keep(ctx: Context?, holder: String) {
    val rc = ctx as? ReactContext ?: return
    UiThreadUtil.runOnUiThread {
      runCatching {
        // no time limit: letGo ends it; allowed in the foreground, where it changes nothing
        val id = HeadlessJsTaskContext.getInstance(rc).startTask(HeadlessJsTaskConfig(TASK, WritableNativeMap(), 0, true))
        tasks.getOrPut(holder) { mutableListOf() }.add(id)
      }
    }
  }

  fun release(ctx: Context?, holder: String) {
    val rc = ctx as? ReactContext ?: return
    UiThreadUtil.runOnUiThread {
      val id = tasks[holder]?.removeLastOrNull() ?: return@runOnUiThread
      runCatching { HeadlessJsTaskContext.getInstance(rc).finishTask(id) }
    }
  }
}
