package main

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// runBackup writes a consistent snapshot of the database (and the HMAC secret) to <data>/backup/.
// The caller then copies <data>/backup and <data>/blobs. Order matters: database first, blobs second,
// so every item in the snapshot has its blobs (extra, unreferenced blobs are harmless).
// The new snapshot is built in backup.new/ and checked before it replaces the old one, so a failed run (a full
// disk, say) leaves the previous snapshot in place instead of none.
// Only one run at a time (a cron job and the nightly timer can overlap): they share backup.new/.
func runBackup(dataDir string) error {
	lock, err := os.OpenFile(filepath.Join(dataDir, "backup.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close() // closing releases the lock
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another backup is running")
	}
	db, err := openDB(filepath.Join(dataDir, "app.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	dir, next, old := filepath.Join(dataDir, "backup"), filepath.Join(dataDir, "backup.new"), filepath.Join(dataDir, "backup.old")
	if err := os.RemoveAll(next); err != nil {
		return err
	}
	if err := os.MkdirAll(next, 0o700); err != nil {
		return err
	}
	if _, err := db.Exec(`VACUUM INTO ?`, filepath.Join(next, "app.db")); err != nil {
		os.RemoveAll(next)
		return fmt.Errorf("database snapshot: %w", err)
	}
	if err := checkSnapshot(filepath.Join(next, "app.db")); err != nil {
		os.RemoveAll(next)
		return fmt.Errorf("database snapshot: %w", err)
	}
	if err := copyFile(filepath.Join(dataDir, "secret"), filepath.Join(next, "secret")); err != nil {
		os.RemoveAll(next)
		return err
	}
	os.RemoveAll(old)
	if err := os.Rename(dir, old); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(next, dir); err != nil {
		os.Rename(old, dir) // put the previous snapshot back
		return err
	}
	os.RemoveAll(old)
	fmt.Println("database snapshot written to", dir)
	return nil
}

// runAfterRestore prepares restored data before the app serves it. Every session ends: the backup brings back
// sessions that were revoked since. Devices signed out on purpose since the backup was made stay marked as such
// (their records are taken over from the replaced database that restore.sh leaves in .previous/), so they still
// delete what they keep. And everything in the restored trash gets a fresh 30 days: the cleanup counts from today's
// date and would otherwise purge, within seconds of starting, exactly the deleted items a restore is usually meant
// to bring back. The incremental lists' cursors (since.go) start a new epoch.
func runAfterRestore(dataDir string) error {
	db, err := openDB(filepath.Join(dataDir, "app.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	ctx := context.Background()
	conn, err := db.Conn(ctx) // ATTACH holds for one connection only, and not inside a transaction
	if err != nil {
		return err
	}
	defer conn.Close()
	prev := filepath.Join(dataDir, ".previous", "app.db")
	carry, accounts := false, false
	if _, err := os.Stat(prev); err == nil {
		if _, err := conn.ExecContext(ctx, `ATTACH DATABASE ? AS prev`, "file:"+prev+"?mode=ro"); err != nil {
			return fmt.Errorf("open the replaced database: %w", err)
		}
		defer conn.ExecContext(ctx, `DETACH DATABASE prev`)
		var n int
		conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM prev.sqlite_master WHERE type='table' AND name='revoked_sessions'`).Scan(&n)
		carry = n > 0 // a database from before signed-out devices were remembered has none
		// the accounts' later state only from the same server (same secret): never from a database of another one
		old, err1 := os.ReadFile(filepath.Join(dataDir, ".previous", "secret"))
		cur, err2 := os.ReadFile(filepath.Join(dataDir, "secret"))
		accounts = err1 == nil && err2 == nil && len(cur) > 0 && string(old) == string(cur)
		if accounts {
			var cols, tables int
			conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('users','prev') WHERE name IN ('kdf','auth_hash','wrapped_master_pw','wrapped_master_recovery','recovery_hash','role','status')`).Scan(&cols)
			conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM prev.sqlite_master WHERE type='table' AND name IN ('invites','audit_log')`).Scan(&tables)
			accounts = cols == 7 && tables == 2
		} else {
			fmt.Println("the replaced data has no secret of this server: accounts are taken as the backup has them")
		}
	} else {
		fmt.Println("no replaced database in .previous/: sign-outs, password changes and disabled or deleted accounts since the backup are not carried over")
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	revoked := int64(0)
	if carry {
		res, err := tx.Exec(`INSERT OR IGNORE INTO main.revoked_sessions(id_hash,at) SELECT id_hash,at FROM prev.revoked_sessions`)
		if err != nil {
			return err
		}
		revoked, _ = res.RowsAffected()
	}
	if accounts {
		if err := carryAccounts(tx); err != nil {
			return err
		}
	}
	res, err := tx.Exec(`DELETE FROM sessions`)
	if err != nil {
		return err
	}
	sessions, _ := res.RowsAffected()
	res, err = tx.Exec(`UPDATE items SET trashed_at=? WHERE trashed_at IS NOT NULL`, time.Now().Unix())
	if err != nil {
		return err
	}
	trashed, _ := res.RowsAffected()
	// the change numbers went back with the database: every device's ?since cursor is void, they load their lists anew
	if _, err := tx.Exec(`INSERT INTO settings(key,value) VALUES ('sync_epoch', lower(hex(randomblob(8)))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fmt.Printf("ended %d sessions; kept %d later sign-outs; %d items in the trash keep it for another 30 days\n", sessions, revoked, trashed)
	return nil
}

// carryAccounts takes over from the replaced database what happened to the accounts since the backup: a changed
// password or recovery key (it wraps the same master key), two-step sign-in turned on or off, passkeys added or
// removed and new recovery codes,
// a changed role, a disabled account, and accounts deleted since stay disabled. A restore brings photos back, not
// access that was taken away (nor a second step that was added). The replaced activity log is kept too, invites that
// were withdrawn or used since stay so, and the accounts' notices are the replaced database's (the newer ones; the
// sign-in notices among them are not shown to the sessions after the restore, which all start later, an
// administrator's reset of two-step sign-in is, until dismissed). The authenticator secrets are sealed under this
// server's secret, which the caller checked is the same (so are the passkey records).
func carryAccounts(tx *sql.Tx) error {
	disabled := []string{}
	rows, err := tx.Query(`SELECT email FROM main.users m WHERE status='active' AND (NOT EXISTS (SELECT 1 FROM prev.users p WHERE p.id=m.id)
		OR EXISTS (SELECT 1 FROM prev.users p WHERE p.id=m.id AND p.status<>'active'))`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var e string
		if rows.Scan(&e) == nil {
			disabled = append(disabled, e)
		}
	}
	rows.Close()
	for _, q := range []string{
		`UPDATE main.users SET kdf=p.kdf, auth_hash=p.auth_hash, wrapped_master_pw=p.wrapped_master_pw,
			wrapped_master_recovery=p.wrapped_master_recovery, recovery_hash=p.recovery_hash, role=p.role, status=p.status
			FROM prev.users p WHERE p.id=users.id`,
		`UPDATE main.users SET status='disabled' WHERE id NOT IN (SELECT id FROM prev.users)`,
		`DELETE FROM main.invites WHERE used_at IS NULL AND token_hash NOT IN (SELECT token_hash FROM prev.invites WHERE used_at IS NULL)`,
		`INSERT INTO main.audit_log(at,actor,action,target,detail) SELECT at,actor,action,target,detail FROM prev.audit_log p
			WHERE NOT EXISTS (SELECT 1 FROM main.audit_log m WHERE m.at=p.at AND m.actor=p.actor AND m.action=p.action AND m.target=p.target AND m.detail=p.detail)
			ORDER BY p.id`,
	} {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	// two-step sign-in, only from a replaced database that knew it (an older one: as the backup has it)
	var cols, tables int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('users','prev') WHERE name IN ('totp_secret','totp_pending','totp_last')`).Scan(&cols); err != nil {
		return err
	}
	if err := tx.QueryRow(`SELECT COUNT(*) FROM prev.sqlite_master WHERE type='table' AND name IN ('recovery_codes','notices')`).Scan(&tables); err != nil {
		return err
	}
	if cols == 3 && tables == 2 {
		for _, q := range []string{
			`UPDATE main.users SET totp_secret=p.totp_secret, totp_pending=p.totp_pending, totp_last=p.totp_last
				FROM prev.users p WHERE p.id=users.id`,
			`DELETE FROM main.recovery_codes WHERE user_id IN (SELECT id FROM prev.users)`,
			`INSERT INTO main.recovery_codes(user_id,code_hash) SELECT user_id,code_hash FROM prev.recovery_codes
				WHERE user_id IN (SELECT id FROM main.users)`,
			`DELETE FROM main.notices WHERE user_id IN (SELECT id FROM prev.users)`,
			`INSERT INTO main.notices(id,user_id,kind,device,session_pub,at,dismissed) SELECT id,user_id,kind,device,session_pub,at,dismissed
				FROM prev.notices WHERE user_id IN (SELECT id FROM main.users) AND id NOT IN (SELECT id FROM main.notices)`,
		} {
			if _, err := tx.Exec(q); err != nil {
				return err
			}
		}
	}
	// passkeys, likewise only from a replaced database that had them
	if err := tx.QueryRow(`SELECT COUNT(*) FROM prev.sqlite_master WHERE type='table' AND name='passkeys'`).Scan(&tables); err != nil {
		return err
	}
	if tables == 1 {
		for _, q := range []string{
			`DELETE FROM main.passkeys WHERE user_id IN (SELECT id FROM prev.users)`,
			`INSERT INTO main.passkeys(id,user_id,cred_id,rp_id,cred,name,created_at,last_used_at)
				SELECT id,user_id,cred_id,rp_id,cred,name,created_at,last_used_at FROM prev.passkeys
				WHERE user_id IN (SELECT id FROM main.users) AND cred_id NOT IN (SELECT cred_id FROM main.passkeys)`,
		} {
			if _, err := tx.Exec(q); err != nil {
				return err
			}
		}
	}
	for _, e := range disabled {
		fmt.Println("stays disabled (disabled or deleted after the backup):", e)
	}
	return nil
}

// checkSnapshot opens a freshly written snapshot on its own and runs SQLite's integrity check on it. Read-only and
// immutable: the check must not turn the file into a WAL database or leave -wal/-shm files next to it.
func checkSnapshot(path string) error {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&immutable=1")
	if err != nil {
		return err
	}
	defer db.Close()
	var res string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&res); err != nil {
		return err
	}
	if res != "ok" {
		return fmt.Errorf("integrity check of the snapshot: %s", res)
	}
	var tables int // an empty file passes the integrity check too
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users','items')`).Scan(&tables); err != nil {
		return err
	}
	if tables != 2 {
		return fmt.Errorf("the snapshot holds no library")
	}
	return nil
}

func copyFile(from, to string) error {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}

type checkResult struct {
	Integrity    string
	Users        int
	Items        int
	Trashed      int
	BlobDirs     int
	MissingBlobs []string // ready items whose files are not all on disk
}

// runCheck verifies the database and that every finished item's segment files exist.
func runCheck(dataDir string) (*checkResult, error) {
	db, err := openDB(filepath.Join(dataDir, "app.db"))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	return checkDB(db, dataDir)
}

func checkDB(db *sql.DB, dataDir string) (*checkResult, error) {
	r := &checkResult{}
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&r.Integrity); err != nil {
		return nil, err
	}
	db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&r.Users)
	db.QueryRow(`SELECT COUNT(*) FROM items WHERE state='ready' AND trashed_at IS NULL`).Scan(&r.Items)
	db.QueryRow(`SELECT COUNT(*) FROM items WHERE state='ready' AND trashed_at IS NOT NULL`).Scan(&r.Trashed)
	rows, err := db.Query(`SELECT id, segment_count FROM items WHERE state='ready'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		if rows.Scan(&id, &n) != nil || !idRe.MatchString(id) {
			continue
		}
		r.BlobDirs++
		for i := 0; i < n; i++ {
			if _, err := os.Stat(filepath.Join(dataDir, "blobs", id[:2], id, fmt.Sprintf("seg%06d", i))); err != nil {
				r.MissingBlobs = append(r.MissingBlobs, id)
				break
			}
		}
	}
	return r, nil
}

func printCheck(r *checkResult) {
	fmt.Printf("integrity: %s\nusers: %d\nitems: %d (+%d in trash)\nitems with missing files: %d\n", r.Integrity, r.Users, r.Items, r.Trashed, len(r.MissingBlobs))
	for _, id := range r.MissingBlobs {
		fmt.Println("  missing files for item", id)
	}
}
