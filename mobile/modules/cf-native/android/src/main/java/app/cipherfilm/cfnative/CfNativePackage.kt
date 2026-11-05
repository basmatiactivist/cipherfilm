package app.cipherfilm.cfnative

import android.app.Application
import android.content.Context
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package
import okhttp3.Dispatcher

/** Before any network module builds its client: OkHttp allows only 5 parallel requests per host by default, which
 *  makes a screen of thumbnails over a slow link (or next to an upload) load a few at a time. */
class CfNativePackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) {
        OkHttpClientProvider.setOkHttpClientFactory {
          OkHttpClientProvider.createClientBuilder(application)
            .dispatcher(Dispatcher().apply { maxRequests = 64; maxRequestsPerHost = 16 })
            .build()
        }
        Thread { NewMedia.catchUp(application) }.start() // a MediaStore query: off the main thread
      }
    })
}
