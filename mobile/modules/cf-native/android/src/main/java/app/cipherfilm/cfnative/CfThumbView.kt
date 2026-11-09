package app.cipherfilm.cfnative

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.view.ViewGroup
import android.widget.ImageView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** One thumbnail, by item id, from [Thumbs]: the grid's tiles, album covers and the viewer's first picture. */
@SuppressLint("ViewConstructor")
class CfThumbView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onFailed by EventDispatcher()
  /** the picture is on screen (the library waits for its first screen before it shows the grid) */
  private val onShown by EventDispatcher()
  private val image = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
  private var item: String? = null
  private var ask: Thumbs.Ask? = null
  private var shown: String? = null // the item whose bitmap is on screen
  private var contain = false
  /** a software copy of the bitmap: where the view is drawn into a software canvas (the map's markers, MapLibre's
   *  view annotations), a hardware bitmap would crash the app */
  private var software = false
  private val changed: () -> Unit = { if (Thumbs.cached(item ?: "") == null && !Thumbs.hasKey(item ?: "")) blank(); load() }

  init {
    addView(image, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    Thumbs.onChange(changed) // a lock blanks it, an unlock loads it again
  }

  fun setItem(id: String?) {
    if (id == item) return
    item = id
    blank()
  }

  fun setSoftware(on: Boolean) {
    if (on == software) return
    software = on
    shown = null
    load()
  }

  fun setFit(fit: String?) {
    contain = fit == "contain"
    image.scaleType = if (contain) ImageView.ScaleType.FIT_CENTER else ImageView.ScaleType.CENTER_CROP
  }

  private fun blank() {
    ask?.wanted = false
    ask = null
    shown = null
    image.animate().cancel()
    image.setImageDrawable(null)
  }

  /** After the props are set, its first layout, and again after an unlock: loads what it should show. */
  fun load() {
    val id = item ?: return
    if (shown == id || ask != null) return
    Thumbs.cached(id)?.let { show(id, it, fade = false); return }
    if (!contain && width == 0) return // decoded at its size: once it has one
    val px = if (contain) 0 else maxOf(width, height) // the viewer's: whole
    val a = Thumbs.Ask(id, px, true) { bmp ->
      if (item != id) return@Ask
      ask = null
      if (bmp != null) show(id, bmp, fade = true) else onFailed(mapOf())
    }
    ask = a
    Thumbs.request(a)
    if (ask === a && Thumbs.cached(id) == null && !Thumbs.hasKey(id)) ask = null // locked: asked again at unlock
  }

  private fun show(id: String, bmp: Bitmap, fade: Boolean) {
    val first = shown != id
    shown = id
    val b = if (software && bmp.config == Bitmap.Config.HARDWARE) bmp.copy(Bitmap.Config.ARGB_8888, false) ?: return else bmp
    image.setImageBitmap(b)
    if (first) onShown(mapOf())
    // no fade on the map: its markers are pictures taken of this view, one taken mid-fade would stay see-through
    if (fade && !software) { image.alpha = 0f; image.animate().alpha(1f).setDuration(120).start() } else image.alpha = 1f
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    super.onLayout(changed, l, t, r, b)
    if (changed) load()
  }

  /** Unmounted (its row left the list's window, a few screens around what is shown): not fetched any more. A view
   *  only clipped off screen (removeClippedSubviews) keeps loading, so it is there when it scrolls in. */
  fun destroy() {
    item = null
    blank()
  }
}
