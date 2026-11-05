package app.cipherfilm.cfnative

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * What the automatic backup (src/backup.ts) needs from Android: the camera's new photos and videos, whether the phone
 * is on Wi-Fi and charging, whether the system lets the app run in the background, and a progress notification.
 */
internal object BackupNative {
  private const val CHANNEL = "backup"
  const val NOTIFICATION = 7101
  /** The person swiped the progress away: it isn't shown again until this run ends. */
  @Volatile var dismissed = false

  private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

  /** "full", "partial" (Android 14's "selected photos only") or "none". Up to Android 12 the storage permission
   *  (declared with maxSdkVersion 32) opens the whole library. */
  fun mediaAccess(ctx: Context): String = when {
    Build.VERSION.SDK_INT < 33 -> if (granted(ctx, Manifest.permission.READ_EXTERNAL_STORAGE)) "full" else "none"
    granted(ctx, Manifest.permission.READ_MEDIA_IMAGES) && granted(ctx, Manifest.permission.READ_MEDIA_VIDEO) -> "full"
    Build.VERSION.SDK_INT >= 34 && granted(ctx, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "partial"
    else -> "none"
  }

  /** Whether what the app reads keeps the photos' location: before Android 10 always, after only with ACCESS_MEDIA_LOCATION. */
  private fun location(ctx: Context) = Build.VERSION.SDK_INT < 29 || granted(ctx, Manifest.permission.ACCESS_MEDIA_LOCATION)

  fun state(ctx: Context): Map<String, Any> {
    val cm = ctx.getSystemService(ConnectivityManager::class.java)
    val caps = cm?.getNetworkCapabilities(cm.activeNetwork)
    val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    val unmetered = online && caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true
    val bm = ctx.getSystemService(BatteryManager::class.java)
    val pm = ctx.getSystemService(PowerManager::class.java)
    return mapOf(
      "online" to online,
      "unmetered" to unmetered,
      "charging" to charging(ctx, bm),
      "battery" to (bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1),
      "batteryExempt" to (pm?.isIgnoringBatteryOptimizations(ctx.packageName) == true),
      "powerSave" to (pm?.isPowerSaveMode == true),
      "media" to mediaAccess(ctx),
      "location" to location(ctx),
      "notifications" to NotificationManagerCompat.from(ctx).areNotificationsEnabled(),
      "sdk" to Build.VERSION.SDK_INT,
    )
  }

  /** Plugged in (AC, USB or wireless), from the battery broadcast Android keeps; the battery manager's own flag as fallback. */
  private fun charging(ctx: Context, bm: BatteryManager?): Boolean {
    val sticky = runCatching { ctx.registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }.getOrNull()
    val plugged = sticky?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
    return if (plugged >= 0) plugged != 0 else bm?.isCharging == true
  }

  private val FILES get() = MediaStore.Files.getContentUri("external")
  // photos and videos, without files still being written (IS_PENDING exists from Android 10)
  private val VISUAL = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}, ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})" +
    if (Build.VERSION.SDK_INT >= 29) " AND ${MediaStore.MediaColumns.IS_PENDING} = 0" else ""

  /** The folder below the storage's root ("DCIM/Camera/"): RELATIVE_PATH from Android 10, from the file's path before. */
  @Suppress("DEPRECATION")
  private val PATH_COLUMN = if (Build.VERSION.SDK_INT >= 29) MediaStore.MediaColumns.RELATIVE_PATH else MediaStore.MediaColumns.DATA
  private fun relativePath(v: String?): String {
    if (v == null || Build.VERSION.SDK_INT >= 29) return v ?: ""
    val root = android.os.Environment.getExternalStorageDirectory().absolutePath.trimEnd('/') + "/"
    val dir = v.substringBeforeLast('/', "") + "/"
    return if (dir.startsWith(root)) dir.removePrefix(root) else ""
  }

  /** Every folder on the phone that holds photos or videos (Camera, Screenshots, WhatsApp Images, ...), largest first. */
  fun folders(ctx: Context): List<Map<String, Any?>> {
    val cols = arrayOf(MediaStore.MediaColumns.BUCKET_ID, MediaStore.MediaColumns.BUCKET_DISPLAY_NAME, PATH_COLUMN, MediaStore.Files.FileColumns._ID)
    val byId = LinkedHashMap<String, MutableMap<String, Any?>>()
    ctx.contentResolver.query(FILES, cols, VISUAL, null, null)?.use { c ->
      while (c.moveToNext()) {
        val bucket = c.getString(0) ?: continue
        val f = byId.getOrPut(bucket) { mutableMapOf("id" to bucket, "name" to (c.getString(1) ?: "Unnamed"), "path" to relativePath(c.getString(2)), "count" to 0, "newest" to 0.0) }
        f["count"] = (f["count"] as Int) + 1
        f["newest"] = maxOf(f["newest"] as Double, c.getLong(3).toDouble())
      }
    }
    return byId.values.sortedByDescending { it["count"] as Int }
  }

  /**
   * Photos and videos in one folder with a MediaStore id above afterId, oldest first. Ids only grow, so the backup
   * remembers the last one it finished per folder. With ACCESS_MEDIA_LOCATION the URI gives the original file, GPS
   * included; otherwise Android removes the location from the EXIF.
   */
  fun media(ctx: Context, bucket: String, afterId: Long, limit: Int): List<Map<String, Any?>> {
    val cols = arrayOf(
      MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.MediaColumns.DISPLAY_NAME,
      MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.MIME_TYPE,
    )
    val where = "$VISUAL AND ${MediaStore.MediaColumns.BUCKET_ID} = ? AND ${MediaStore.Files.FileColumns._ID} > ?"
    val args = arrayOf(bucket, afterId.toString())
    val order = "${MediaStore.Files.FileColumns._ID} ASC"
    // a limit: query arguments from Android 11, "LIMIT" after the sort order before (which Android 11 refuses)
    val cursor = if (Build.VERSION.SDK_INT >= 30) {
      val q = android.os.Bundle().apply {
        putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, where)
        putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args)
        putString(android.content.ContentResolver.QUERY_ARG_SQL_SORT_ORDER, order)
        putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, limit)
      }
      ctx.contentResolver.query(FILES, cols, q, null)
    } else ctx.contentResolver.query(FILES, cols, where, args, "$order LIMIT $limit")
    // the original file (GPS included) needs ACCESS_MEDIA_LOCATION from Android 10; before, every file is original
    val original = Build.VERSION.SDK_INT >= 29 && granted(ctx, Manifest.permission.ACCESS_MEDIA_LOCATION)
    val out = mutableListOf<Map<String, Any?>>()
    cursor?.use { c ->
      while (c.moveToNext()) {
        val id = c.getLong(0)
        val video = c.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        var uri: Uri = ContentUris.withAppendedId(if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        if (original) uri = MediaStore.setRequireOriginal(uri)
        out.add(mapOf("id" to id.toDouble(), "uri" to uri.toString(), "name" to c.getString(2), "size" to c.getLong(3).toDouble(), "mime" to c.getString(4)))
      }
    }
    return out
  }

  /** Every photo and video on the phone with its folder and date, for "Free up space"; ids are the MediaStore ids. */
  fun allMedia(ctx: Context): List<Map<String, Any?>> {
    val cols = arrayOf(
      MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.MediaColumns.DISPLAY_NAME,
      MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.BUCKET_ID,
      MediaStore.MediaColumns.BUCKET_DISPLAY_NAME, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_ADDED,
    )
    val out = mutableListOf<Map<String, Any?>>()
    ctx.contentResolver.query(FILES, cols, VISUAL, null, "${MediaStore.Files.FileColumns._ID} ASC")?.use { c ->
      while (c.moveToNext()) {
        val id = c.getLong(0)
        val video = c.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        val uri = ContentUris.withAppendedId(if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        val taken = if (c.isNull(7)) c.getLong(8) * 1000 else c.getLong(7)
        out.add(mapOf("id" to id.toDouble(), "uri" to uri.toString(), "name" to c.getString(2), "size" to c.getLong(3).toDouble(), "mime" to c.getString(4),
          "bucket" to c.getString(5), "folder" to (c.getString(6) ?: ""), "taken" to taken.toDouble()))
      }
    }
    return out
  }

  /** How many photos and videos in a folder come after afterId (for "12 waiting"). */
  fun countAfter(ctx: Context, bucket: String, afterId: Long): Int =
    ctx.contentResolver.query(FILES, arrayOf(MediaStore.Files.FileColumns._ID), "$VISUAL AND ${MediaStore.MediaColumns.BUCKET_ID} = ? AND ${MediaStore.Files.FileColumns._ID} > ?", arrayOf(bucket, afterId.toString()), null)?.use { it.count } ?: 0

  /** Whether this build declares REQUEST_IGNORE_BATTERY_OPTIMIZATIONS: the GitHub build does, the Play build doesn't
   *  (CF_STORE=play, app.config.js), because Play allows that direct request only for a few kinds of apps. */
  private fun mayAskDirectly(ctx: Context): Boolean = runCatching {
    @Suppress("DEPRECATION")
    val info = ctx.packageManager.getPackageInfo(ctx.packageName, PackageManager.GET_PERMISSIONS)
    info.requestedPermissions?.contains(Manifest.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) == true
  }.getOrDefault(false)

  /** The system's own "Allow to run in the background?" dialog for this app where the build may ask for it; otherwise
   *  (and if that fails) Android's list of battery optimisations, where the person picks Cipherfilm themselves. */
  fun askBatteryExemption(ctx: Context) {
    val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (!mayAskDirectly(ctx)) { runCatching { ctx.startActivity(list) }.onFailure { openAppSettings(ctx) }; return }
    val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { ctx.startActivity(i) }.onFailure { runCatching { ctx.startActivity(list) }.onFailure { openAppSettings(ctx) } }
  }

  fun openAppSettings(ctx: Context) {
    ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  /** A quiet notification while the backup runs; progress < 0 is indeterminate. */
  fun notify(ctx: Context, title: String, text: String, progress: Double, ongoing: Boolean) {
    if (ongoing && dismissed) return
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
    if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
    // the result has its own id: the progress one goes with the service when that stops
    runCatching {
      if (ongoing) nm.cancel(NOTIFICATION + 1)
      nm.notify(if (ongoing) NOTIFICATION else NOTIFICATION + 1, build(ctx, title, text, progress, ongoing))
    }
  }

  /** The notification itself, also the one the upload service (TransferService) shows. */
  fun build(ctx: Context, title: String, text: String, progress: Double, ongoing: Boolean): android.app.Notification {
    val nm = ctx.getSystemService(NotificationManager::class.java)
    if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Backup", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Progress of the automatic backup"
        setShowBadge(false)
      })
    }
    val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
      android.app.PendingIntent.getActivity(ctx, 0, it, android.app.PendingIntent.FLAG_IMMUTABLE)
    }
    val gone = android.app.PendingIntent.getBroadcast(ctx, 1, Intent(ctx, TransferService.Dismissed::class.java), android.app.PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle(title)
      .setContentText(text)
      .setOnlyAlertOnce(true)
      .setOngoing(ongoing)
      .setSilent(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setContentIntent(open)
      .apply { if (ongoing) { setDeleteIntent(gone); setProgress(1000, (progress.coerceIn(0.0, 1.0) * 1000).toInt(), progress < 0) } }
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  fun cancel(ctx: Context) {
    dismissed = false
    ctx.getSystemService(NotificationManager::class.java)?.apply { cancel(NOTIFICATION); cancel(NOTIFICATION + 1) }
  }
}
