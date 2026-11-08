package app.cipherfilm.cfnative

import android.os.Process
import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher

/**
 * Where the long native jobs run. Expo runs every AsyncFunction of every module on one thread
 * ("expo.modules.AsyncFunctionQueue"): expo/fetch starts each request and reads each answer there, expo-file-system and
 * SecureStore pass through it too. A model download (minutes), a model's hash (hundreds of MB), opening the models
 * (seconds) or analyzing a photo (about a second, two at a time while indexing) held that thread, so every request of
 * the app waited behind them: a screen that loads something (Account › Search and people asks the server for the
 * account first) stayed empty for as long. These lanes take that work off it; the AsyncFunctions only hand over and wait.
 */
internal object Lanes {
  private fun lane(name: String) = Executors.newSingleThreadExecutor { r ->
    Thread({ Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); r.run() }, name)
  }

  /** The ONNX models: one job at a time, in the order asked (open before analyze, close after the last analyze). */
  val visionExecutor = lane("cf-vision")
  val vision = visionExecutor.asCoroutineDispatcher()
  /** The decrypted index in memory (SearchIndex.kt): saving, loading, clustering; also in the order asked. */
  val index = lane("cf-index").asCoroutineDispatcher()
  /** Model files: downloads and hashes, which only wait on the network or the disk. */
  val files = lane("cf-models").asCoroutineDispatcher()
}
