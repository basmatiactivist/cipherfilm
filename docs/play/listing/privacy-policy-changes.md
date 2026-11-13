# Privacy policy changes needed for Google Play

For the website session. Pages: `src/components/Privacy.astro` → https://cipherfilm.app/privacy (EN) and
https://cipherfilm.app/de/datenschutz (DE). Play enters the English URL.

## Why

Play's User Data policy requires the privacy policy to cover **the app**, not just the website: the entity as named
on the listing ("Cipherfilm"), a privacy contact, which data the app accesses, collects, uses and shares, how it is
protected, and how long it is kept and how to delete it. It must be labelled as a privacy policy, be public HTML,
and be linked inside the app. The current page covers the website and has only a two-sentence section "The app
itself". It must stay consistent with the Data safety answers in `console-answers.md` (only the sign-in e-mail
address is declared as collected; photos, videos and location are exempt because they are end-to-end encrypted).

## Changes

1. **Title and lead.** Keep `<h1>Privacy</h1>` / `<h1>Datenschutz</h1>`, but make the page title
   "Privacy policy · Cipherfilm" / "Datenschutzerklärung · Cipherfilm" and change the lead so it covers both:
   - EN: "This privacy policy covers the Cipherfilm apps (Android, Mac and the web app that comes with the server) and this website. In short: the apps send your data only to the server you sign in to, encrypted, and never to us. This website sets no cookies, has no analytics and loads nothing from other servers."
   - DE: "Diese Datenschutzerklärung gilt für die Cipherfilm-Apps (Android, Mac und die Web-App, die mit dem Server kommt) und für diese Website. Kurz gesagt: Die Apps schicken Ihre Daten nur an den Server, bei dem Sie sich anmelden, verschlüsselt, und nie an uns. Diese Website setzt keine Cookies, hat keine Statistik und lädt nichts von anderen Servern."
2. **"Who is responsible"** stays ("Cipherfilm, the open-source project …, Contact: `<Mail />`"). Add one sentence:
   - EN: "Cipherfilm is the name shown as the developer on Google Play."
   - DE: "Cipherfilm ist der Name, der auf Google Play als Entwickler angezeigt wird."
   No personal name anywhere.
3. **Replace** the section "The app itself" / "Die App selbst" with the section below, placed **before**
   "What happens when you visit" (the app is what Play reviewers look for). Then the website sections follow under a
   new `<h2>This website</h2>` / `<h2>Diese Website</h2>` heading (turn their current `h2`s into `h3`s).
4. **"Your rights"** stays; add the sentence about app data from the section below.
5. Add at the end: "Last updated: <date of publication>" / "Stand: <Datum der Veröffentlichung>", and
   "If this policy changes, the new version is published on this page." / "Ändert sich diese Erklärung, steht die neue Fassung auf dieser Seite."
6. Add a footer link to the account deletion page (`delete-account-page.md`).

---

## New section, English

```html
<h2>The Cipherfilm apps</h2>
<p>Cipherfilm is self-hosted. The apps connect only to the Cipherfilm server whose address you enter when you sign in. That server is run by you or by the person who invited you (its administrator). We, the Cipherfilm project, run no server for you, and the apps send nothing to us: no photos, no e-mail address, no usage data, no crash reports.</p>

<h3>What the Android app accesses on your phone</h3>
<ul>
  <li><strong>Photos and videos</strong> (permissions "Photos and videos" and, if you allow it, "Location in photos"): to show your library, to back up the folders you choose, also in the background when automatic backup is on, and to free up space by moving backed-up originals to the phone's trash when you ask for it. If you allow access to selected photos only, the app backs up only those.</li>
  <li><strong>Location stored in your photos</strong> (EXIF GPS data): read together with the photo and encrypted with it. The app has no access to your phone's current location.</li>
  <li><strong>Files you share to Cipherfilm</strong> from other apps: uploaded to your library, encrypted.</li>
  <li><strong>Fingerprint or face unlock</strong>: handled entirely by Android. The app never receives biometric data; it only learns whether unlocking succeeded, and then releases its key from the phone's secure hardware.</li>
  <li><strong>Notifications</strong>: to show backup and upload progress, and security notices (a new sign-in to your account, changes to two-step sign-in). For those the app asks your own server about every 15 minutes; no push service is used, and they never show on the lock screen.</li>
  <li><strong>Network</strong>: to your server; once to Hugging Face to download the search models; and, only if you turn the map on, to the map service (below); only over HTTPS.</li>
</ul>
<p id="models">Search by content and faces runs on your phone, with open models that the app downloads once from Hugging Face, the public site where they are published, after it asked you (it says what, how big, and that they come from the site named here). Turning search off deletes them. Hugging Face sees your phone's IP address and that it downloaded these public files, nothing else: no account, photo or search. Nothing is sent anywhere to be analysed.</p>

<h3 id="map">The map</h3>
<p>The map is off until you turn it on. Then the map images come from an external map service: by default OpenFreeMap, with VersaTiles when OpenFreeMap doesn't answer, or the map server your Cipherfilm server's administrator set instead. That service sees your device's IP address and which areas you look at: the region with most of your photos when the map opens, where you zoom or move, and, when you open a photo's details, the area around that photo (district level). It never gets a photo, its exact position or anything else from your library; the photos are placed on the map on your device. No cookies or referrer are sent. Turning the map off stops this.</p>

<h3>What is encrypted before it leaves your phone</h3>
<p>Photos, videos, thumbnails, file names, dates taken, places, camera details, album names, names of people, the search index and the list of faces are encrypted on your device (XChaCha20-Poly1305, with keys that only your password or your recovery key can open). The server stores them but cannot read them, and neither can we. Your password and your recovery key never leave your device.</p>

<h3>What your server can see</h3>
<p>To run your account, the server you sign in to necessarily stores some data it can read:</p>
<ul>
  <li>the e-mail address you sign in with (it is only a login name; Cipherfilm never sends e-mail),</li>
  <li>whether you are an administrator, when your account was created and when you last signed in,</li>
  <li>how many photos and videos you have, roughly how big they are, and when they were uploaded or deleted,</li>
  <li>how many albums you have and which items are in which, and which items are favourites,</li>
  <li>a short label for each signed-in device (the phone's maker and model, followed by "(Android app)"; never the name you gave the phone), so you can sign one out,</li>
  <li>if you turn on two-step sign-in: that it is on, the authenticator app's secret (stored encrypted), your passkeys' public keys and names, and the unused recovery codes as keyed hashes,</li>
  <li>security notices for your devices (new sign-ins with the device label and time, changes to two-step sign-in), kept at most 90 days,</li>
  <li>your storage use and limit.</li>
</ul>
<p>Your IP address is used only briefly in memory to limit sign-in attempts; the server writes no request logs. The administrator of your server is responsible for that server and its backups. We have no access to it.</p>

<h3>What the apps don't do</h3>
<p>No ads, no analytics, no tracking, no crash reporting, no advertising ID, and no data shared with or sold to anyone. The apps contain no third-party SDK that sends data elsewhere.</p>

<h3>How long data is kept, and how to delete it</h3>
<p>Your data stays on your server until you delete it. Deleted items go to the trash and are permanently removed after 30 days, or at once when you empty the trash. You can delete your account with all its photos, videos, albums and search data at any time: in the Android app under Account → Delete account, in the Mac app under Settings → General, in the web app, or by asking your server's administrator. Copies in the administrator's server backups are kept, encrypted, until the administrator's backup retention removes them. Details: <a href="/delete-account">Delete your Cipherfilm account</a>.</p>
<p>Signing out in the app deletes what the app keeps for your account on that phone. Uninstalling the app removes everything it stored on the phone.</p>

<h3>Children</h3>
<p>Cipherfilm is not directed at children under 13.</p>
```

Addition to **"Your rights"** (EN):

> Data in the apps is on the server you sign in to, not with us. To see, correct or delete it, use the app or ask
> your server's administrator. We can't access it.

---

## Neuer Abschnitt, Deutsch

```html
<h2>Die Cipherfilm-Apps</h2>
<p>Cipherfilm wird selbst gehostet. Die Apps verbinden sich nur mit dem Cipherfilm-Server, dessen Adresse Sie bei der Anmeldung eingeben. Diesen Server betreiben Sie selbst oder die Person, die Sie eingeladen hat (sein Administrator). Wir, das Projekt Cipherfilm, betreiben keinen Server für Sie, und die Apps schicken nichts an uns: keine Fotos, keine E-Mail-Adresse, keine Nutzungsdaten, keine Absturzberichte.</p>

<h3>Worauf die Android-App auf Ihrem Handy zugreift</h3>
<ul>
  <li><strong>Fotos und Videos</strong> (Berechtigungen „Fotos und Videos“ und, wenn Sie es erlauben, „Standort in Fotos“): um Ihre Bibliothek anzuzeigen, um die von Ihnen gewählten Ordner zu sichern, bei eingeschaltetem automatischem Backup auch im Hintergrund, und um auf Ihren Wunsch Speicher freizugeben, indem gesicherte Originale in den Papierkorb des Handys verschoben werden. Erlauben Sie nur den Zugriff auf ausgewählte Fotos, sichert die App nur diese.</li>
  <li><strong>Ortsangaben in Ihren Fotos</strong> (EXIF-GPS-Daten): werden mit dem Foto gelesen und mit ihm verschlüsselt. Auf den aktuellen Standort Ihres Handys hat die App keinen Zugriff.</li>
  <li><strong>Dateien, die Sie aus anderen Apps mit Cipherfilm teilen</strong>: werden verschlüsselt in Ihre Bibliothek hochgeladen.</li>
  <li><strong>Entsperren mit Fingerabdruck oder Gesicht</strong>: erledigt Android vollständig. Die App erhält keine biometrischen Daten; sie erfährt nur, ob das Entsperren geklappt hat, und gibt dann ihren Schlüssel aus der sicheren Hardware des Handys frei.</li>
  <li><strong>Benachrichtigungen</strong>: um den Fortschritt von Backup und Uploads anzuzeigen, und für Sicherheitsmitteilungen (eine neue Anmeldung bei Ihrem Konto, Änderungen an der Anmeldung in zwei Schritten). Dafür fragt die App etwa alle 15 Minuten Ihren eigenen Server; kein Push-Dienst wird verwendet, und auf dem Sperrbildschirm erscheinen sie nie.</li>
  <li><strong>Netzwerk</strong>: zu Ihrem Server; einmalig zu Hugging Face, um die Suchmodelle zu laden; und nur wenn Sie die Karte einschalten, zum Kartendienst (unten); nur über HTTPS.</li>
</ul>
<p id="models">Die Suche nach Inhalten und Gesichtern läuft auf Ihrem Handy, mit offenen Modellen, die die App einmalig von Hugging Face lädt, der öffentlichen Website, auf der sie veröffentlicht sind, nachdem sie Sie gefragt hat (sie sagt, was, wie groß und dass sie von der hier genannten Website kommen). Wenn Sie die Suche ausschalten, werden sie gelöscht. Hugging Face sieht die IP-Adresse Ihres Handys und dass es diese öffentlichen Dateien geladen hat, sonst nichts: kein Konto, kein Foto, keine Suche. Nichts wird zur Analyse irgendwohin geschickt.</p>

<h3 id="map">Die Karte</h3>
<p>Die Karte ist aus, bis Sie sie einschalten. Dann kommen die Kartenbilder von einem externen Kartendienst: standardmäßig OpenFreeMap, mit VersaTiles, wenn OpenFreeMap nicht antwortet, oder der Kartenserver, den der Administrator Ihres Cipherfilm-Servers stattdessen eingestellt hat. Dieser Dienst sieht die IP-Adresse Ihres Geräts und welche Gebiete Sie ansehen: die Region mit den meisten Ihrer Fotos, wenn die Karte öffnet, wohin Sie zoomen oder schieben, und wenn Sie die Angaben eines Fotos öffnen, die Gegend um dieses Foto (auf Ebene eines Stadtteils). Er bekommt nie ein Foto, seine genaue Position oder sonst etwas aus Ihrer Bibliothek; die Fotos werden auf Ihrem Gerät auf die Karte gesetzt. Es werden keine Cookies und kein Referrer gesendet. Wenn Sie die Karte ausschalten, hört das auf.</p>

<h3>Was verschlüsselt wird, bevor es Ihr Handy verlässt</h3>
<p>Fotos, Videos, Vorschaubilder, Dateinamen, Aufnahmedaten, Orte, Kameradaten, Albumnamen, Namen von Personen, der Suchindex und die Liste der Gesichter werden auf Ihrem Gerät verschlüsselt (XChaCha20-Poly1305, mit Schlüsseln, die nur Ihr Passwort oder Ihr Wiederherstellungsschlüssel öffnet). Der Server speichert sie, kann sie aber nicht lesen, und wir auch nicht. Ihr Passwort und Ihr Wiederherstellungsschlüssel verlassen Ihr Gerät nie.</p>

<h3>Was Ihr Server sieht</h3>
<p>Um Ihr Konto zu führen, speichert der Server, bei dem Sie sich anmelden, zwangsläufig einige Daten lesbar:</p>
<ul>
  <li>die E-Mail-Adresse, mit der Sie sich anmelden (sie ist nur ein Anmeldename; Cipherfilm verschickt nie E-Mails),</li>
  <li>ob Sie Administrator sind, wann Ihr Konto angelegt wurde und wann Sie sich zuletzt angemeldet haben,</li>
  <li>wie viele Fotos und Videos Sie haben, ungefähr wie groß sie sind und wann sie hochgeladen oder gelöscht wurden,</li>
  <li>wie viele Alben Sie haben, was in welchem liegt und welche Einträge Favoriten sind,</li>
  <li>eine kurze Bezeichnung für jedes angemeldete Gerät (Hersteller und Modell des Handys, gefolgt von „(Android app)“; nie der Name, den Sie dem Handy gegeben haben), damit Sie es abmelden können,</li>
  <li>wenn Sie die Anmeldung in zwei Schritten einschalten: dass sie an ist, das Geheimnis der Authenticator-App (verschlüsselt gespeichert), die öffentlichen Schlüssel und Namen Ihrer Passkeys und die unbenutzten Wiederherstellungscodes als verschlüsselte Prüfwerte,</li>
  <li>Sicherheitsmitteilungen für Ihre Geräte (neue Anmeldungen mit Gerätebezeichnung und Zeit, Änderungen an der Anmeldung in zwei Schritten), höchstens 90 Tage lang,</li>
  <li>Ihren belegten Speicher und Ihr Limit.</li>
</ul>
<p>Ihre IP-Adresse wird nur kurz im Arbeitsspeicher verwendet, um Anmeldeversuche zu begrenzen; der Server schreibt keine Zugriffsprotokolle. Für diesen Server und seine Backups ist sein Administrator verantwortlich. Wir haben keinen Zugriff darauf.</p>

<h3>Was die Apps nicht tun</h3>
<p>Keine Werbung, keine Statistik, kein Tracking, keine Absturzberichte, keine Werbe-ID, und keine Daten werden an andere weitergegeben oder verkauft. Die Apps enthalten kein Drittanbieter-SDK, das Daten anderswohin schickt.</p>

<h3>Wie lange Daten bleiben und wie Sie sie löschen</h3>
<p>Ihre Daten bleiben auf Ihrem Server, bis Sie sie löschen. Gelöschte Einträge kommen in den Papierkorb und werden nach 30 Tagen endgültig entfernt, oder sofort, wenn Sie den Papierkorb leeren. Ihr Konto mit allen Fotos, Videos, Alben und Suchdaten können Sie jederzeit löschen: in der Android-App unter Account → Delete account, in der Mac-App unter Settings → General, in der Web-App oder über den Administrator Ihres Servers. Kopien in den Server-Backups des Administrators bleiben verschlüsselt erhalten, bis seine Aufbewahrungsfrist sie entfernt. Einzelheiten: <a href="/de/konto-loeschen">Cipherfilm-Konto löschen</a>.</p>
<p>Abmelden in der App löscht, was die App für Ihr Konto auf diesem Handy speichert. Deinstallieren entfernt alles, was sie auf dem Handy gespeichert hat.</p>

<h3>Kinder</h3>
<p>Cipherfilm richtet sich nicht an Kinder unter 13 Jahren.</p>
```

Ergänzung zu **„Ihre Rechte“** (DE):

> Die Daten in den Apps liegen auf dem Server, bei dem Sie sich anmelden, nicht bei uns. Um sie einzusehen, zu
> berichtigen oder zu löschen, nutzen Sie die App oder fragen Sie den Administrator Ihres Servers. Wir haben keinen
> Zugriff darauf.

---

## Check before publishing

- [ ] The facts still match the app: permissions in the merged manifest, no analytics SDK, `expo-updates` off,
      HTTPS-only, search models downloaded from Hugging Face (pinned, SHA-256 checked), the default map service
      (OpenFreeMap, VersaTiles as fallback; `web/src/places/mapHosts.ts`), "Delete account" present in the Android, Mac and web apps.
- [ ] The Mac app accesses chosen folders (watched and export folders) and Touch ID; if the Mac app is meant to be
      covered in detail, add one line: "On the Mac: the folders you choose to watch or export to, and Touch ID
      (handled by macOS)." / "Auf dem Mac: die Ordner, die Sie zum Beobachten oder Exportieren wählen, und Touch ID
      (erledigt macOS)."
- [x] The app links this page on the sign-in screen and under Account (since 2.1.8). The model and map questions link
      `#models` and `#map` (the ids in the sections above), since the apps' texts name no companies.
- [ ] Page reachable without cookies or geo-blocking; `/privacy` returns 200 (it does today).
