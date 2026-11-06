# Server commands

The server image has commands for whoever runs it. Run them in the folder with your `compose.yaml`, while the server
runs:

```bash
docker compose exec app /app help
```

They work on the same database as the running server. Every change is written to the audit log (Admin › Activity)
as "server console".

| Command | What it does |
|---|---|
| `status` | Version, accounts, photos and videos, storage used, signed-in devices, last database snapshot and off-site backup. |
| `list-users` | Every account: role, status, photos, storage used and limit, explicit search, last sign-in. |
| `make-admin EMAIL` | Makes the account an administrator (administrators have no storage limit). |
| `revoke-admin EMAIL` | Makes an administrator an ordinary user again, with the default storage limit. One active administrator must remain. |
| `disable-user EMAIL` | Locks the account: it can't sign in, and all its devices are signed out. Nothing is deleted. |
| `enable-user EMAIL` | Lets a locked account sign in again. |
| `delete-user EMAIL --yes` | Deletes the account with all its photos, albums and search data, permanently. Without `--yes` it only says what it would delete. People can also delete their own account (Account › Delete account in the web, Android and Mac apps; `DELETE /api/me`). |
| `set-quota EMAIL GB` | Sets the storage limit, for example `50`, `1.5`, `unlimited` or `default`. |
| `allow-explicit EMAIL` / `deny-explicit EMAIL` | Allows explicit search for the account, or turns it off (docs/SEARCH.md). |
| `list-sessions [EMAIL]` | Signed-in devices, of everyone or of one account: device, when signed in, last active, which one indexes. |
| `sign-out EMAIL [--wipe]` | Signs out all devices of the account. With `--wipe` the devices also delete what they keep of the library when they next reach the server (for a lost phone). |
| `invite EMAIL [--quota GB] [--url URL]` | Makes an invite link, valid for 7 days. `--url` is your Cipherfilm address; without it the server uses `PUBLIC_HOSTS`, or prints the path to put after your address. |
| `reset-password EMAIL` | Explains why this isn't possible, and what to do instead (below). |
| `backup` | Writes a consistent snapshot of the database to `/data/backup` (before an update). |
| `check` | Checks the database and that every stored file is there. |
| `revoke-sessions` | Signs out every device of every account (after restoring an older backup). |
| `version` | Prints the version. |

Examples:

```bash
docker compose exec app /app list-users
docker compose exec app /app make-admin anna@example.org
docker compose exec app /app set-quota ben@example.org 100
docker compose exec app /app invite carla@example.org --url https://photos.example.org
docker compose exec app /app sign-out ben@example.org --wipe
```

## Why there is no password reset

Immich can reset a password from the server because the server can read the photos. Cipherfilm can't: the password
unlocks the account's keys, and the server has neither the password nor the keys (docs/CRYPTO.md). A command that
reset the password would also give the administrator the photos.

- **The person has their recovery key** (24 words): on the sign-in page, "Forgot password", then a new password.
- **The recovery key is lost too:** nobody can open those photos any more. To start over with the same address:
  `delete-user EMAIL --yes`, then `invite EMAIL`.
- **Only stop someone from signing in:** `disable-user EMAIL` or `sign-out EMAIL`.
