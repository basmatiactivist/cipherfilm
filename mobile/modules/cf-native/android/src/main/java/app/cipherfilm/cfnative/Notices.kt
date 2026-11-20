package app.cipherfilm.cfnative

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Account notices (a new sign-in elsewhere, two-step sign-in turned off, an unfinished sign-in) as Android
 * notifications, for when the app isn't open: src/noticeCheck.ts decides which and words them; this only shows them.
 * Secret on the lock screen (VISIBILITY_SECRET, the notification and its channel): a private notification would show
 * its full text there when the phone's setting shows all notification content, so the device and the time appear
 * only once the phone is unlocked, whatever that setting is. The public version ("New sign-in to Cipherfilm") is
 * what Android may show where it redacts. A tap opens the app with cipherfilm://notice, which leads to Account ›
 * Devices (after unlocking).
 */
internal object Notices {
  private const val CHANNEL = "security"
  private const val TAG = "notice"

  private fun channel(ctx: Context) {
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
    // created once; created again (which renames it in place) when the phone's language changed since. Its importance
    // is the person's after that (Android keeps what they chose).
    val name = de("Security", "Sicherheit")
    val about = de("New sign-ins to your account and other changes you should know about", "Neue Anmeldungen bei Ihrem Konto und andere Änderungen, die Sie kennen sollten")
    if (nm.getNotificationChannel(CHANNEL)?.let { it.name == name && it.description == about } == true) return
    nm.createNotificationChannel(NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_HIGH).apply {
      description = about
      lockscreenVisibility = NotificationCompat.VISIBILITY_SECRET
    })
  }

  /** Allowed by Android: notifications for the app, and this channel not switched off (not made yet counts as on). */
  fun allowed(ctx: Context): Boolean {
    if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return false
    val ch = ctx.getSystemService(NotificationManager::class.java)?.getNotificationChannel(CHANNEL)
    return ch == null || ch.importance != NotificationManager.IMPORTANCE_NONE
  }

  /** Shows one notice; false when Android doesn't allow it (then it isn't counted as shown). */
  fun show(ctx: Context, id: Int, title: String, text: String, publicTitle: String): Boolean {
    if (!allowed(ctx)) return false
    channel(ctx)
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("cipherfilm://notice")).setPackage(ctx.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val tap = PendingIntent.getActivity(ctx, 2, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val icon = android.R.drawable.ic_lock_idle_lock
    val public = NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(icon).setContentTitle(publicTitle).setContentIntent(tap).build()
    val n = NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_SECRET) // never on the lock screen, whatever the phone's setting
      .setPublicVersion(public)
      .setContentIntent(tap)
      .setAutoCancel(true)
      .build()
    return runCatching { ctx.getSystemService(NotificationManager::class.java)?.notify(TAG, id, n) }.isSuccess
  }

  /** Takes a notice's notification down (dismissed on some device, or shown in the app now). */
  fun cancel(ctx: Context, id: Int) {
    ctx.getSystemService(NotificationManager::class.java)?.cancel(TAG, id)
  }

  fun cancelAll(ctx: Context) {
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
    nm.activeNotifications.filter { it.tag == TAG }.forEach { nm.cancel(TAG, it.id) }
  }

  // ---- custom reviews (src/reviewSchedule.ts): "A review is ready", on a channel of their own ----

  private const val REVIEWS = "reviews"
  private const val REVIEW_TAG = "review"

  private fun reviewChannel(ctx: Context) {
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
    val name = de("Reviews", "Rückblicke")
    val about = de("When one of your custom reviews is ready to watch", "Wenn einer Ihrer eigenen Rückblicke bereit ist")
    if (nm.getNotificationChannel(REVIEWS)?.let { it.name == name && it.description == about } == true) return
    nm.createNotificationChannel(NotificationChannel(REVIEWS, name, NotificationManager.IMPORTANCE_DEFAULT).apply {
      description = about
      lockscreenVisibility = NotificationCompat.VISIBILITY_SECRET
    })
  }

  /** Shows the one review notification (replacing the one up, if any); false when Android doesn't allow it. The text
   *  is generic (never what a review is about), and secret on the lock screen like the notices. A tap opens the app as
   *  its icon does: Photos (after unlocking), where the reviews are. (Its launch intent, not a cipherfilm:// link, so a
   *  build with another scheme, the test package, opens too.) */
  fun showReview(ctx: Context, title: String, text: String, publicTitle: String): Boolean {
    if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return false
    val ch = ctx.getSystemService(NotificationManager::class.java)?.getNotificationChannel(REVIEWS)
    if (ch != null && ch.importance == NotificationManager.IMPORTANCE_NONE) return false
    reviewChannel(ctx)
    val open = (ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return false)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val tap = PendingIntent.getActivity(ctx, 3, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val icon = android.R.drawable.ic_menu_gallery
    val public = NotificationCompat.Builder(ctx, REVIEWS).setSmallIcon(icon).setContentTitle(publicTitle).setContentIntent(tap).build()
    val n = NotificationCompat.Builder(ctx, REVIEWS)
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(text)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setVisibility(NotificationCompat.VISIBILITY_SECRET)
      .setPublicVersion(public)
      .setContentIntent(tap)
      .setAutoCancel(true)
      .build()
    return runCatching { ctx.getSystemService(NotificationManager::class.java)?.notify(REVIEW_TAG, 1, n) }.isSuccess
  }

  fun cancelReview(ctx: Context) {
    ctx.getSystemService(NotificationManager::class.java)?.cancel(REVIEW_TAG, 1)
  }
}
