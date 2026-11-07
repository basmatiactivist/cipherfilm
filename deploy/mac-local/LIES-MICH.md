# fotocrypt: deine eigene Cipherfilm-Instanz

Läuft auf diesem Mac in OrbStack. Adresse: **https://fotocrypt.orb.local** (nur von diesem Mac aus erreichbar, nichts ist im Netzwerk freigegeben).
Alles, was du hochlädst, wird im Browser verschlüsselt. Der Server speichert nur Chiffretext.

## Erster Start (einmalig)

1. `open https://fotocrypt.orb.local` (oder `./fotocrypt.sh open`)
2. Setup-Token: steht in `SETUP-TOKEN.txt` in diesem Ordner (nur für dich lesbar). Falls die Datei veraltet ist: `./fotocrypt.sh token`.
3. Gib Token, deine E-Mail-Adresse und ein Passwort ein (mindestens 10 Zeichen).
4. **Schreibe die 24 Wörter des Recovery-Keys auf** (Passwortmanager oder Papier). Sie werden nur einmal gezeigt. Ohne Passwort UND Recovery-Key sind die Fotos unwiederbringlich weg, auch für mich.
5. Danach ist das Token wertlos. Weitere Personen lädst du im Admin-Bereich ein (Avatar oben rechts, Admin, Users, "Invite someone").

## Alltag

| Befehl | Wirkung |
|---|---|
| `./fotocrypt.sh start` / `stop` / `restart` | Instanz starten, stoppen (Daten bleiben) |
| `./fotocrypt.sh status` | läuft sie, ist die Datenbank in Ordnung |
| `./fotocrypt.sh logs` | Protokoll ansehen |
| `./fotocrypt.sh backup` | Sicherung nach `backups/` (Datenbank plus verschlüsselte Dateien) |
| `./fotocrypt.sh restore backups/<datei>.tar --yes` | Sicherung zurückspielen (ersetzt alle Daten, die alten bleiben in `data.vorher-...`) |
| `./fotocrypt.sh list` / `export [ziel]` | Konten ansehen / Originale direkt aus `data/` holen (siehe unten) |
| `./fotocrypt.sh update [quellordner]` | neueste Version aus dem Quellcode bauen (Standard: `~/Desktop/Crypt`) und neu starten (macht vorher eine Sicherung) |

Die Instanz startet nach einem Neustart von OrbStack von selbst (`restart: unless-stopped`). OrbStack muss laufen.

## Wo liegen die Daten?

- `data/`: Datenbank (`app.db`), Server-Geheimnis (`secret`), verschlüsselte Fotos (`blobs/`). Nicht von Hand verändern.
- `backups/`: deine Sicherungen. **Eine Sicherung auf demselben Mac schützt nicht vor einem Festplattenausfall.** Kopiere sie regelmäßig auf eine externe Platte oder einen anderen Rechner.
- `image/fotocrypt-image.tar.gz`: das Programm als Docker-Image, falls du es später ohne den Quellcode neu starten willst (`docker load < image/fotocrypt-image.tar.gz`).
- `tools/`: das Entschlüsselungs-Programm (siehe unten).

## Fotos herausholen (ohne App, ohne Sicherung)

Das Entschlüsselungs-Programm liest den Ordner `data/` direkt. Docker, die laufende App und eine Sicherung sind nicht nötig. Es verändert nichts in `data/`.

```bash
cd ~/Desktop/fotocrypt
./fotocrypt.sh list                      # welche Konten und wie viele Fotos (ohne Passwort)
./fotocrypt.sh export ~/Pictures/fotocrypt-export
```

Es fragt nach deinem Passwort (die Eingabe bleibt unsichtbar). Mit mehreren Konten: `--email du@example.org` anhängen. Mit dem Recovery-Key statt Passwort: `--recovery`. Nur prüfen ohne Dateien zu schreiben: `--verify`.

Die Originale kommen unverändert unter `Library/<Jahr>/<Jahr-Monat>/`, gelöschte unter `Trash/` und Alben als Ordner unter `Albums/`. Das Aufnahmedatum wird als Dateidatum gesetzt.

**Auch wenn du nur den Ordner hast:** Kopiere `data/` und `tools/` auf einen beliebigen Mac, dann geht es ebenso (`tools/fotocrypt-decrypt-mac-arm64 --out ZIEL data`). Eine Sicherung (`.tar`) musst du nur vorher entpacken; der entpackte Ordner geht genauso.

Hinweis: Läuft die App gerade und lädt jemand in dem Moment hoch, kann der allerletzte Upload fehlen. Für einen vollständigen Stand zuerst `./fotocrypt.sh stop`.

Beim ersten Start blockiert macOS die Datei eventuell: `xattr -d com.apple.quarantine tools/*`. Intel-Mac: `fotocrypt-decrypt-mac-intel`.

## Gut zu wissen

- Erreichbar nur von diesem Mac. Für Zugriff vom Handy brauchst du HTTPS davor, z. B. Tailscale Serve oder einen eigenen Proxy (siehe `docs/SELF-HOSTING.md` im Projekt, Abschnitt "Deploy"). Das gilt auch für die Android-App.
- Die Entwicklungsinstanz `https://cipherfilm.orb.local` ist getrennt und hat andere Daten. Lösche sie nicht aus Versehen mit `make reset` im Projektordner: das betrifft nur sie, nicht fotocrypt.
- Wer Zugriff auf diesen Ordner und dein Passwort hat, kommt an die Fotos. Wer nur den Ordner hat, nicht.

## Umzug auf einen Server

Sicherung machen (`./fotocrypt.sh backup`), die `.tar`-Datei auf den Server kopieren und dort mit
`scripts/restore.sh` einspielen. Die Schritt-für-Schritt-Anleitung steht im Projekt unter `docs/MIGRATION.md`.
Passwörter und Wiederherstellungsschlüssel bleiben gleich, alle melden sich einmal an der neuen Adresse an.
