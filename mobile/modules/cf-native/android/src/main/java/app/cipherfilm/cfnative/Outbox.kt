package app.cipherfilm.cfnative

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The decrypted copies in the outbox (cache/cf-out, src/outbox.ts) are removed by the app when it starts, locks, shares
 * again or comes back after a while. None of that happens when Android ends the app after a share and it isn't opened
 * again: the copies would wait, unencrypted, until the next start. This job, scheduled whenever the outbox gets new
 * copies, removes what is older than the app's own grace period (the receiving app may still be reading right after
 * the share) even when the app isn't running. It doesn't need the library unlocked, only the file dates.
 */
internal object Outbox {
  private const val WORK = "cipherfilm-outbox-sweep"
  const val KEEP_MS = 15 * 60 * 1000L // as src/outbox.ts KEEP_FOR

  fun dir(ctx: Context) = File(ctx.cacheDir, "cf-out")

  /** Runs [sweep] once the newest copies are past the grace period; a later call moves it back. From the running job:
   *  after it (replacing a running job would cancel it). */
  fun sweepLater(ctx: Context, fromJob: Boolean = false) {
    val req = OneTimeWorkRequestBuilder<Work>().setInitialDelay(KEEP_MS + 60_000, TimeUnit.MILLISECONDS).build() // not java.time: Android 7 has none
    runCatching { WorkManager.getInstance(ctx).enqueueUniqueWork(WORK, if (fromJob) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.REPLACE, req) }
  }

  /** Removes every share or save folder in the outbox whose newest file is older than [KEEP_MS]; true if any remain. */
  fun sweep(root: File, now: Long = System.currentTimeMillis()): Boolean {
    val entries = root.listFiles() ?: return false
    var left = false
    for (e in entries) {
      // a folder still being written (a large video, part by part) has fresh dates and stays
      val newest = e.walkTopDown().maxOfOrNull { it.lastModified() } ?: 0L
      if (now - newest >= KEEP_MS) e.deleteRecursively() else left = true
    }
    return left
  }

  class Work(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
      if (sweep(dir(applicationContext))) sweepLater(applicationContext, fromJob = true) // newer copies: their turn comes later
      return Result.success()
    }
  }
}
