package main

import (
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
// sessions that were revoked since. And everything in the restored trash gets a fresh 30 days: the cleanup counts
// from today's date and would otherwise purge, within seconds of starting, exactly the deleted items a restore is
// usually meant to bring back.
func runAfterRestore(dataDir string) error {
	db, err := openDB(filepath.Join(dataDir, "app.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
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
	if err := tx.Commit(); err != nil {
		return err
	}
	fmt.Printf("ended %d sessions; %d items in the trash keep it for another 30 days\n", sessions, trashed)
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
	Integrity     string
	Users         int
	Items         int
	Trashed       int
	BlobDirs      int
	MissingBlobs  []string // ready items whose files are not all on disk
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
