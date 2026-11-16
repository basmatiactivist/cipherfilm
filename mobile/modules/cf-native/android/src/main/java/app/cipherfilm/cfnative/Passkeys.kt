package app.cipherfilm.cfnative

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import expo.modules.kotlin.exception.CodedException

/**
 * Passkeys as the second step of a sign-in (server/passkeys.go), through Android's Credential Manager: the server's
 * WebAuthn options go in as JSON, the passkey provider's answer (Google Password Manager, Bitwarden, a security key…)
 * comes back as JSON. Android checks the server's /.well-known/assetlinks.json before it lets the app use a passkey of
 * the server's name. Only from Android 14, where Credential Manager is part of the system: older phones would need
 * Google Play services' copy, which the app doesn't bring along; they keep the code from the authenticator app.
 */
internal class PasskeyFailed(code: String, message: String) : CodedException(code, message, null)

internal object Passkeys {
  fun supported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE

  private fun manager(activity: Activity?): Pair<CredentialManager, Activity> {
    if (!supported()) throw PasskeyFailed("ERR_PASSKEY_UNSUPPORTED", "Passkeys need Android 14 or newer")
    val a = activity ?: throw PasskeyFailed("ERR_PASSKEY", "No window to ask in")
    return CredentialManager.create(a) to a
  }

  /** Makes a passkey for the server's creation options; returns the registration response JSON. */
  suspend fun create(activity: Activity?, optionsJson: String): String {
    val (cm, a) = manager(activity)
    try {
      val r = cm.createCredential(a, CreatePublicKeyCredentialRequest(optionsJson))
      return (r as? CreatePublicKeyCredentialResponse)?.registrationResponseJson
        ?: throw PasskeyFailed("ERR_PASSKEY", "No passkey was made")
    } catch (e: CreateCredentialCancellationException) {
      throw PasskeyFailed("ERR_PASSKEY_CANCELLED", "cancelled")
    } catch (e: CreateCredentialException) {
      throw PasskeyFailed("ERR_PASSKEY", "${e.errorMessage?.toString() ?: ""} [${e.type}]".trim())
    }
  }

  /** Asks for a passkey's answer to the server's request options; returns the authentication response JSON. */
  suspend fun get(activity: Activity?, optionsJson: String): String {
    val (cm, a) = manager(activity)
    try {
      val r = cm.getCredential(a, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(optionsJson))))
      return (r.credential as? PublicKeyCredential)?.authenticationResponseJson
        ?: throw PasskeyFailed("ERR_PASSKEY", "No passkey was used")
    } catch (e: GetCredentialCancellationException) {
      throw PasskeyFailed("ERR_PASSKEY_CANCELLED", "cancelled")
    } catch (e: NoCredentialException) {
      throw PasskeyFailed("ERR_PASSKEY_NONE", "No passkey for this server on this phone")
    } catch (e: GetCredentialException) {
      throw PasskeyFailed("ERR_PASSKEY", "${e.errorMessage?.toString() ?: ""} [${e.type}]".trim())
    }
  }
}

/**
 * A secret copied on purpose (the authenticator key during setup, the recovery codes): marked sensitive, so Android
 * 13+ doesn't show it in the copy preview and keyboards don't suggest it, and taken off the clipboard again after a
 * minute unless something else was copied meanwhile. Nothing decrypted from the library ever goes here
 * (plaintext.test.ts).
 */
internal object SecretClip {
  private const val CLEAR_AFTER_MS = 60_000L
  /** The copy's own random mark, in its description: what is cleared is only the very clip this app put there. */
  private const val MARK = "app.cipherfilm.secret-clip"
  private val main = Handler(Looper.getMainLooper())
  private var pending: Runnable? = null

  fun copy(ctx: Context, label: String, text: String) {
    main.post {
      val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val mark = java.util.UUID.randomUUID().toString()
      val clip = ClipData.newPlainText(label, text)
      // ClipDescription.EXTRA_IS_SENSITIVE from Android 13; the same key is read by earlier keyboards that honour it
      clip.description.extras = PersistableBundle().apply {
        putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
        putString(MARK, mark)
      }
      // one clear at a time, for the newest copy: all on the main thread, nothing registered that could be left behind
      pending?.let { main.removeCallbacks(it) }
      cm.setPrimaryClip(clip)
      val r = Runnable {
        pending = null
        if (stillThere(cm, mark)) {
          if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
        }
      }
      pending = r
      main.postDelayed(r, CLEAR_AFTER_MS)
    }
  }

  /** Whether the clipboard still holds this copy: anything copied since has no mark or another one. Where Android
   *  doesn't let the app look (in the background, from Android 10), it counts as still there: the secret rather goes. */
  private fun stillThere(cm: ClipboardManager, mark: String): Boolean {
    val d = runCatching { cm.primaryClipDescription }.getOrNull() ?: return true
    return d.extras?.getString(MARK) == mark
  }
}
