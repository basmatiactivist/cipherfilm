package app.cipherfilm.cfnative

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference

/**
 * The viewer's video player: Android's own player and controls, reading through [VaultDataSource]. It covers the whole
 * page like the photo below it (the same fit), so the still shows exactly under the video until its first frame and
 * nothing of it sticks out; only the controls keep clear of the viewer's top and bottom bars ([setControlsInset]).
 * The viewer's bars come and go with the controls: a tap shows or hides both (onControls), and with the bars hidden a
 * video starts without its controls ([setControls]). onBuffering tells the viewer when to show its loading badge.
 */
@SuppressLint("ViewConstructor")
@UnstableApi
class CfVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val view = PlayerView(context).apply {
    setShowNextButton(false)
    setShowPreviousButton(false)
    setShowShuffleButton(false)
    controllerShowTimeoutMs = 2500
    setShutterBackgroundColor(Color.TRANSPARENT) // the still shows until the first frame, not a black box
    setKeepContentOnPlayerReset(true)
  }
  private var player: ExoPlayer? = null
  private var item: String? = null
  private var controls = true
  private val onControls by EventDispatcher()
  private val onBuffering by EventDispatcher()
  private val state = object : Player.Listener {
    override fun onPlaybackStateChanged(playbackState: Int) {
      onBuffering(mapOf("buffering" to (playbackState == Player.STATE_BUFFERING)))
    }
    override fun onPlayerError(error: PlaybackException) { onBuffering(mapOf("buffering" to false)) }
  }

  init {
    addView(view, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    synchronized(all) { all.add(WeakReference(this)) }
    // only while a video plays here: letting go of the player hides the controls, which isn't the person's tap
    view.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v ->
      if (player != null) onControls(mapOf("visible" to (v == View.VISIBLE)))
    })
  }

  fun setItem(id: String?) {
    if (id == item) return
    release()
    item = id
    if (id == null || VideoVault.get(id) == null) return
    val p = ExoPlayer.Builder(context)
      .setMediaSourceFactory(DefaultMediaSourceFactory { VaultDataSource() })
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
      .setHandleAudioBecomingNoisy(true)
      .build()
    p.addListener(state)
    p.setMediaItem(MediaItem.fromUri(VideoVault.uri(id)))
    p.prepare()
    p.playWhenReady = true
    view.controllerAutoShow = controls
    view.player = p
    player = p
  }

  /** The viewer's bars shown (the controls too) or hidden (the controls too, and they don't show on their own). */
  fun setControls(on: Boolean) {
    controls = on
    view.controllerAutoShow = on
    if (player == null) return
    // again when already shown (after a tap): it then stays while the video is paused, as with the bars shown
    if (on) view.showController() else view.hideController()
  }

  /** Room for the viewer's bars, in dp: the controls sit between them, the picture doesn't. */
  fun setControlsInset(top: Double, bottom: Double) {
    val d = resources.displayMetrics.density
    view.findViewById<View>(androidx.media3.ui.R.id.exo_controller)?.setPadding(0, (top * d).toInt(), 0, (bottom * d).toInt())
  }

  fun pause() { player?.pause() }

  fun release() {
    val p = player
    player = null // first: the controls hiding now is no tap (the listener in init)
    view.player = null
    p?.removeListener(state)
    p?.release()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    release()
    item = null
  }

  companion object {
    private val all = mutableListOf<WeakReference<CfVideoView>>()
    /** When the app goes to the background or locks, nothing keeps playing. */
    fun pauseAll() = synchronized(all) {
      all.removeAll { it.get() == null }
      all.forEach { it.get()?.let { v -> v.post { v.pause() } } }
    }
    fun releaseAll() = synchronized(all) {
      all.removeAll { it.get() == null }
      all.forEach { it.get()?.let { v -> v.post { v.release() } } }
    }
  }
}
