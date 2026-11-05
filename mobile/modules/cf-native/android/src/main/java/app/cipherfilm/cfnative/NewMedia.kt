package app.cipherfilm.cfnative

import android.content.Context
import android.provider.MediaStore
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import expo.modules.backgroundtask.BackgroundTaskConsumer
import expo.modules.interfaces.taskManager.TaskServiceProviderHelper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitAll
import java.time.Duration

/**
 * Starts the backup a few seconds after a new photo or video appears, instead of waiting for the next periodic run:
 * a WorkManager job that Android starts when MediaStore changes. It runs the same JS task as the periodic run
 * (src/backup.ts), then watches again (a content trigger fires once). When the photo's change has to start the app
 * first, WorkManager may reschedule its jobs on the way and lose that change: catchUp, at every start of the app,
 * runs once more if MediaStore has photos newer than the last run saw.
 */
object NewMedia {
  private const val WORK = "cipherfilm-new-media"
  private const val NOW = "cipherfilm-new-media-now"
  private const val PREFS = "cf-new-media"

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** The newest photo or video's MediaStore id (ids only grow); -1 without access. */
  private fun newest(ctx: Context): Long = runCatching {
    ctx.contentResolver.query(MediaStore.Files.getContentUri("external"), arrayOf(MediaStore.Files.FileColumns._ID),
      "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}, ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})",
      null, "${MediaStore.Files.FileColumns._ID} DESC")?.use { if (it.moveToFirst()) it.getLong(0) else 0L } ?: -1L
  }.getOrDefault(-1L)

  fun catchUp(ctx: Context) {
    val p = prefs(ctx)
    if (!p.getBoolean("on", false)) return
    val now = newest(ctx)
    if (now <= p.getLong("seen", Long.MAX_VALUE)) return
    val req = OneTimeWorkRequestBuilder<Work>().setInputData(workDataOf("catchUp" to true))
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
    runCatching { WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, req) }
  }

  /** One more run in a few minutes, after a run that couldn't reach the server (instead of the next periodic one). */
  fun retrySoon(ctx: Context, minutes: Long) {
    if (!prefs(ctx).getBoolean("on", false)) return
    val req = OneTimeWorkRequestBuilder<Work>().setInputData(workDataOf("catchUp" to true))
      .setInitialDelay(Duration.ofMinutes(minutes))
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
    runCatching { WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, req) }
  }

  fun watch(ctx: Context, on: Boolean, next: Boolean = false) {
    val wm = WorkManager.getInstance(ctx)
    val p = prefs(ctx)
    p.edit().putBoolean("on", on).apply()
    if (on && !p.contains("seen")) p.edit().putLong("seen", newest(ctx)).apply()
    if (!on) { wm.cancelUniqueWork(WORK); wm.cancelUniqueWork(NOW); return }
    val constraints = Constraints.Builder()
      .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
      .addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
      .setTriggerContentUpdateDelay(Duration.ofSeconds(3)) // a burst of photos starts one run
      .setTriggerContentMaxDelay(Duration.ofSeconds(20))
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .build()
    val req = OneTimeWorkRequestBuilder<Work>().setConstraints(constraints).build()
    // from the running job: after it; from the app: keep one that already waits
    wm.enqueueUniqueWork(WORK, if (next) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, req)
  }

  class Work(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
      prefs(applicationContext).edit().putLong("seen", newest(applicationContext)).apply()
      watch(applicationContext, true, next = !inputData.getBoolean("catchUp", false))
      val tasks = TaskServiceProviderHelper.getTaskServiceImpl(applicationContext)
        ?.getTaskConsumers(applicationContext.packageName)?.filterIsInstance<BackgroundTaskConsumer>().orEmpty()
      tasks.map { c ->
        CompletableDeferred<Unit>().also { done ->
          runCatching { c.executeTask { done.complete(Unit) } }.onFailure { done.complete(Unit) }
        }
      }.awaitAll()
      return Result.success()
    }
  }
}
