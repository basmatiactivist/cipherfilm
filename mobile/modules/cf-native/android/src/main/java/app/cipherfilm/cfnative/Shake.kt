package app.cipherfilm.cfnative

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import kotlin.math.sqrt

/**
 * Shake to lock and close, as some banking apps do against a phone grabbed out of the hand: two strong jolts (over
 * 2.7 g) within about a second. Listens only while the app is on screen and the person has it turned on; the
 * accelerometer needs no permission and nothing about the movement is kept.
 */
internal object Shake {
  private const val G = 2.7f
  private const val WINDOW_MS = 1200L
  private const val GAP_MS = 150L

  private var manager: SensorManager? = null
  private var wanted = false
  private var listening = false
  private var first = 0L
  private var last = 0L
  var onShake: (() -> Unit)? = null

  private val listener = object : SensorEventListener {
    override fun onSensorChanged(e: SensorEvent) {
      val (x, y, z) = Triple(e.values[0], e.values[1], e.values[2])
      val g = sqrt(x * x + y * y + z * z) / SensorManager.GRAVITY_EARTH
      if (g < G) return
      val now = SystemClock.elapsedRealtime()
      if (now - last < GAP_MS) return // the same jolt
      if (first == 0L || now - first > WINDOW_MS) { first = now; last = now; return }
      first = 0L; last = now
      onShake?.invoke()
    }
    override fun onAccuracyChanged(s: Sensor?, a: Int) {}
  }

  @Synchronized fun want(context: Context, on: Boolean) { wanted = on; if (on) resume(context) else pause() }

  @Synchronized fun resume(context: Context) {
    if (!wanted || listening) return
    val m = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
    val s = m.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
    manager = m
    listening = m.registerListener(listener, s, SensorManager.SENSOR_DELAY_UI)
  }

  @Synchronized fun pause() {
    if (listening) manager?.unregisterListener(listener)
    listening = false; first = 0L
  }
}
