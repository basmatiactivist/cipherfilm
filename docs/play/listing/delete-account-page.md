# Content for https://cipherfilm.app/delete-account (EN) and https://cipherfilm.app/de/konto-loeschen (DE)

For the website session. Play requires a public page, reachable without the app, that names **Cipherfilm** and
says how to request deletion of the account and its data, what is deleted and what is kept. The URL entered in the
Data safety form is the English one: `https://cipherfilm.app/delete-account`.

Notes for building it:
- Same layout as the privacy page (`Privacy.astro`): `<article class="doc wrap"><div class="measure">`.
- Link it from the footer next to "Privacy" ("Delete account" / "Konto löschen"), add it to the sitemap, and set
  `alt={{ en: "/delete-account", de: "/de/konto-loeschen" }}`.
- `<Mail />` stands for the existing obfuscated contact address component.
- Page title: "Delete your Cipherfilm account · Cipherfilm" / "Cipherfilm-Konto löschen · Cipherfilm".
- Meta description: "How to delete your Cipherfilm account and all its photos: in the app, in the browser, or through your server's administrator." /
  "So löschen Sie Ihr Cipherfilm-Konto mit allen Fotos: in der App, im Browser oder über den Administrator Ihres Servers."

---

## English

# Delete your Cipherfilm account

**In short:** your Cipherfilm account lives on the Cipherfilm server you signed in to, not with us. You can delete
it yourself in the app or in the browser, at any time. The Cipherfilm developer holds no account data and no
photos, so there is nothing to delete on our side.

## Where your account is

Cipherfilm is self-hosted. Every account exists only on one server, run by you or by the person who invited you
(your server's administrator). We, the Cipherfilm open-source project, run no server for you and receive none of
your data: no e-mail address, no photos, no videos, no usage data.

## Delete it in the Android app

1. Open Cipherfilm and unlock it.
2. Tap **Account**.
3. Tap **Delete account**, read the warning, enter your password and confirm.

## Delete it in the browser

1. Open your Cipherfilm server's address in a browser and sign in.
2. Open **Account** (your avatar, top right) → **Delete account**.
3. Enter your password, tick the confirmation and tap **Delete account for good**.

You don't need the Android app installed for this.

## If you can't sign in any more

Ask your server's administrator to delete the account. They can do it in the web app under **Admin**, or on the
server with:

```
docker compose exec app /app delete-user you@example.org --yes
```

If you don't know who runs your server, it is the person who sent you the invite link. If you run the server
yourself, you are the administrator.

## What is deleted

At once and for good, from that server:
- your account and the e-mail address you sign in with,
- all your photos and videos, including the trash,
- your albums, favourites, people and search data,
- your encryption keys stored on the server (all of them encrypted),
- every signed-in device: they are all signed out.

Nobody can bring the data back afterwards, not even the administrator.

## What may be kept

- **Server backups.** If your administrator makes backups of the server, copies of your encrypted data stay in
  those backups until the administrator's own backup retention removes them. They are ciphertext: without your
  password or recovery key they cannot be opened. Ask your administrator how long backups are kept.
- **The administrator's activity log** on the server may keep a short entry that an account was deleted (time and
  e-mail address), as part of the last 500 admin events.
- **Your phone.** Photos on your phone are not touched. Deleting the account in the app also removes what the app
  keeps on that phone for the account. Uninstall the app to remove it completely.

## Questions

Write to <Mail />. We can explain how deletion works, but we can't delete accounts on someone else's server: we
have no access to it.

---

## Deutsch

# Cipherfilm-Konto löschen

**Kurz gesagt:** Ihr Cipherfilm-Konto liegt auf dem Cipherfilm-Server, bei dem Sie sich angemeldet haben, nicht
bei uns. Sie können es jederzeit selbst in der App oder im Browser löschen. Die Entwickler von Cipherfilm haben
keine Kontodaten und keine Fotos; bei uns gibt es also nichts zu löschen.

## Wo Ihr Konto liegt

Cipherfilm wird selbst gehostet. Jedes Konto gibt es nur auf einem Server, den Sie selbst betreiben oder die
Person, die Sie eingeladen hat (der Administrator Ihres Servers). Wir, das Open-Source-Projekt Cipherfilm,
betreiben keinen Server für Sie und erhalten keine Ihrer Daten: keine E-Mail-Adresse, keine Fotos, keine Videos,
keine Nutzungsdaten.

## In der Android-App löschen

1. Öffnen und entsperren Sie Cipherfilm.
2. Tippen Sie auf **Account**.
3. Tippen Sie auf **Delete account**, lesen Sie die Warnung, geben Sie Ihr Passwort ein und bestätigen Sie.

(Die App ist derzeit auf Englisch.)

## Im Browser löschen

1. Öffnen Sie die Adresse Ihres Cipherfilm-Servers im Browser und melden Sie sich an.
2. Öffnen Sie **Account** (Ihr Profilbild oben rechts) → **Delete account**.
3. Geben Sie Ihr Passwort ein, setzen Sie das Häkchen und tippen Sie auf **Delete account for good**.

Dafür muss die Android-App nicht installiert sein.

## Wenn Sie sich nicht mehr anmelden können

Bitten Sie den Administrator Ihres Servers, das Konto zu löschen. Er kann das in der Web-App unter **Admin** tun
oder auf dem Server mit:

```
docker compose exec app /app delete-user sie@example.org --yes
```

Wenn Sie nicht wissen, wer Ihren Server betreibt: Es ist die Person, die Ihnen den Einladungslink geschickt hat.
Betreiben Sie den Server selbst, sind Sie der Administrator.

## Was gelöscht wird

Sofort und endgültig, auf diesem Server:
- Ihr Konto und die E-Mail-Adresse, mit der Sie sich anmelden,
- alle Ihre Fotos und Videos, auch der Papierkorb,
- Ihre Alben, Favoriten, Personen und Suchdaten,
- Ihre auf dem Server gespeicherten Schlüssel (alle verschlüsselt),
- alle angemeldeten Geräte: Sie werden überall abgemeldet.

Danach kann niemand die Daten zurückholen, auch der Administrator nicht.

## Was erhalten bleiben kann

- **Server-Backups.** Macht Ihr Administrator Backups des Servers, bleiben Kopien Ihrer verschlüsselten Daten
  darin, bis seine eigene Aufbewahrungsfrist sie entfernt. Es ist Chiffretext: Ohne Ihr Passwort oder Ihren
  Wiederherstellungsschlüssel lässt er sich nicht öffnen. Fragen Sie Ihren Administrator, wie lange Backups
  aufbewahrt werden.
- **Das Aktivitätsprotokoll des Administrators** auf dem Server kann einen kurzen Eintrag behalten, dass ein Konto
  gelöscht wurde (Zeitpunkt und E-Mail-Adresse), als Teil der letzten 500 Admin-Ereignisse.
- **Ihr Handy.** Fotos auf Ihrem Handy bleiben unberührt. Wenn Sie das Konto in der App löschen, entfernt sie auch,
  was sie für dieses Konto auf dem Handy speichert. Deinstallieren Sie die App, um sie ganz zu entfernen.

## Fragen

Schreiben Sie an <Mail />. Wir erklären gern, wie das Löschen funktioniert, können aber keine Konten auf dem
Server von jemand anderem löschen: Darauf haben wir keinen Zugriff.
