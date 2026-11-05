# End-to-end tests

`make e2e` starts a throwaway stack from `compose.e2e.yaml` (the app image behind Caddy with a locally issued HTTPS
certificate, plus Playwright), runs the whole suite, then checks that no plaintext reached the server's disk. It needs
only Docker, never touches the dev stack and is the same command GitHub CI runs on every push. `make e2e-down` removes
it. `make bench` runs the upload benchmark on that stack afterwards (`BROWSER=firefox` or `webkit` to switch engines).

The suite creates its own accounts. **Their passwords are random per checkout** and are kept in
`e2e/.e2e-passwords.json` (created on the first run, git-ignored); `creds.ts` hands them to the specs. Nothing in the
repository is a usable credential. 

| Account | What it holds after a full run |
|---|---|
| `admin@example.org` | The admin area; an empty library |
| `carol@example.org` | JPEG, HEIC and a video placeholder |
| `dave@example.org` | Photos, albums and 400 deliberately unreadable test items |
| `erin@example.org` | A playable WebM, a broken video, long and emoji file names |
| `frank@example.org` | One photo and a rotated recovery key |

Every `make e2e` run resets its stack. Never point the suite at an instance that holds real data.
