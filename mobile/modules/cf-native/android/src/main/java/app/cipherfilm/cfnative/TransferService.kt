package app.cipherfilm.cfnative

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the app running while photos upload (the backup, or files shared to Cipherfilm): a foreground service with
 * the progress notification and a wake lock. Without it Android freezes the app seconds after it leaves the screen,
 * and a background run gets ten minutes at most. Swiping the notification away or the app out of the recent apps
 * doesn't stop it; it ends when the last upload is done, or when Android ends it (Android 15 allows six hours a day).
 */
class TransferService : Service() {
  companion object {
    private val holders = mutableMapOf<String, Int>()
    @Volatile private var lost = false

    /** Starts (or keeps) the service for one more holder. False if Android doesn't allow it right now. */
    fun hold(ctx: Context, holder: String, title: String, text: String): Boolean {
      synchronized(holders) {
        val first = holders.isEmpty()
        holders[holder] = (holders[holder] ?: 0) + 1
        if (!first && !lost) return true
        lost = false
        BackupNative.dismissed = false
      }
      val i = Intent(ctx, TransferService::class.java).putExtra("title", title).putExtra("text", text)
      return runCatching { ContextCompat.startForegroundService(ctx, i) }.isSuccess.also { ok -> if (!ok) release(ctx, holder) }
    }

    /** One holder is done; the service stops after the last. */
    fun release(ctx: Context, holder: String) {
      synchronized(holders) {
        val n = (holders[holder] ?: return) - 1
        if (n > 0) holders[holder] = n else holders.remove(holder)
        if (holders.isNotEmpty()) return
      }
      ctx.stopService(Intent(ctx, TransferService::class.java))
    }

    /** Android ended the service before the uploads were done (time limit, or it couldn't start). */
    fun lost() = lost
  }

  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val n = BackupNative.build(this, intent?.getStringExtra("title") ?: de("Uploading", "Wird hochgeladen"), intent?.getStringExtra("text") ?: "", -1.0, true)
    val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
    val ok = runCatching { ServiceCompat.startForeground(this, BackupNative.NOTIFICATION, n, type) }.isSuccess
    if (!ok) { lost = true; stopSelf(); return START_NOT_STICKY }
    if (wake == null) {
      // the screen may go off; the uploads go on. Released in onDestroy, and by Android after six hours at the latest.
      wake = getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cipherfilm:upload")?.apply {
        setReferenceCounted(false)
        acquire(6 * 3600_000L)
      }
    }
    // after a crash nothing would be left to do the uploads: don't restart
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    lost = true
    stopSelf()
  }

  override fun onDestroy() {
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    synchronized(holders) { if (holders.isNotEmpty()) lost = true }
    super.onDestroy()
  }

  /** The notification was swiped away: the uploads go on, without showing their progress again. */
  class Dismissed : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      BackupNative.dismissed = true
    }
  }
}
