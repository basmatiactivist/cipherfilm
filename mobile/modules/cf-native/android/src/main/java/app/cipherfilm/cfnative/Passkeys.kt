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
  private val main = Handler(Looper.getMainLooper())
  private var pending: Runnable? = null
  private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null

  fun copy(ctx: Context, label: String, text: String) {
    main.post {
      val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val clip = ClipData.newPlainText(label, text)
      // ClipDescription.EXTRA_IS_SENSITIVE from Android 13; the same key is read by earlier keyboards that honour it
      clip.description.extras = PersistableBundle().apply {
        putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
      }
      forget(cm)
      cm.setPrimaryClip(clip)
      var replaced = false
      val l = ClipboardManager.OnPrimaryClipChangedListener { replaced = true }
      // registered after our own change, so only a later copy counts
      main.post { cm.addPrimaryClipChangedListener(l) }
      listener = l
      val r = Runnable {
        cm.removePrimaryClipChangedListener(l)
        if (!replaced) {
          if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
        }
        pending = null
        listener = null
      }
      pending = r
      main.postDelayed(r, CLEAR_AFTER_MS)
    }
  }

  private fun forget(cm: ClipboardManager) {
    pending?.let { main.removeCallbacks(it) }
    listener?.let { cm.removePrimaryClipChangedListener(it) }
    pending = null
    listener = null
  }
}
