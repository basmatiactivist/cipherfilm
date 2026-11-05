package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// backupDir is a Cipherfilm backup: a SQLite database and the folder of encrypted blobs.
type backupDir struct {
	dbPath, blobs, tmp string
	db                 *sql.DB
}

func fileExists(p string) bool { fi, err := os.Stat(p); return err == nil && fi.Mode().IsRegular() }
func dirExists(p string) bool  { fi, err := os.Stat(p); return err == nil && fi.IsDir() }

// newest is the latest modification time of a database file and its write-ahead log.
func newest(db string) time.Time {
	var t time.Time
	for _, p := range []string{db, db + "-wal"} {
		if fi, err := os.Stat(p); err == nil && fi.ModTime().After(t) {
			t = fi.ModTime()
		}
	}
	return t
}

// findBackup accepts a folder that holds app.db next to blobs/: the live data folder of an instance (its app.db, the
// -wal file and blobs/), a copy of the whole Docker volume, or an extracted backup (backup/app.db + blobs/). When a
// folder has both a live database and an older snapshot in backup/, the newer one wins, so nothing uploaded since the
// last backup is left out.
func findBackup(root string) (dbPath, blobs string, err error) {
	var best [2]string
	var bestTime time.Time
	for _, c := range [][2]string{
		{filepath.Join(root, "backup", "app.db"), filepath.Join(root, "blobs")}, // consistent snapshot
		{filepath.Join(root, "app.db"), filepath.Join(root, "blobs")},           // live data folder or raw volume
		{filepath.Join(root, "app.db"), filepath.Join(filepath.Dir(root), "blobs")},
	} {
		if !fileExists(c[0]) {
			continue
		}
		if !dirExists(c[1]) {
			// an instance that never received an upload has no blobs/ yet: nothing to decrypt, but listing still works
			if _, err := os.Stat(filepath.Join(root, "blobs")); err == nil || c[1] != filepath.Join(root, "blobs") {
				continue
			}
		}
		if t := newest(c[0]); best[0] == "" || t.After(bestTime) {
			best, bestTime = c, t
		}
	}
	if best[0] != "" {
		return best[0], best[1], nil
	}
	return "", "", fmt.Errorf("no Cipherfilm data found in %s: expected app.db (or backup/app.db) next to a blobs/ folder. If you have a .tar file, extract it first", root)
}

// openBackup copies the database aside (so a live volume copy with a -wal file replays cleanly and the original is never touched).
func openBackup(root string) (*backupDir, error) {
	dbPath, blobs, err := findBackup(root)
	if err != nil {
		return nil, err
	}
	tmp, err := os.MkdirTemp("", "cipherfilm-decrypt-")
	if err != nil {
		return nil, err
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		src := dbPath + suffix
		if !fileExists(src) {
			continue
		}
		if err := copyFile(src, filepath.Join(tmp, "app.db"+suffix)); err != nil {
			os.RemoveAll(tmp)
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(tmp, "app.db")+"?_pragma=busy_timeout(5000)")
	if err != nil {
		os.RemoveAll(tmp)
		return nil, err
	}
	if err := db.Ping(); err != nil {
		os.RemoveAll(tmp)
		return nil, err
	}
	return &backupDir{dbPath: dbPath, blobs: blobs, tmp: tmp, db: db}, nil
}

func (b *backupDir) Close() {
	b.db.Close()
	os.RemoveAll(b.tmp)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

type account struct {
	ID, Email                              string
	KDF                                    kdfParams
	WrappedMasterPW, WrappedMasterRecovery string
	WrappedPrivkey                         string
	Items                                  int
}

func (b *backupDir) accounts() ([]account, error) {
	rows, err := b.db.Query(`SELECT id,email,kdf,wrapped_master_pw,wrapped_master_recovery,wrapped_privkey,
		(SELECT COUNT(*) FROM items i WHERE i.user_id=u.id AND i.state='ready') FROM users u ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []account
	for rows.Next() {
		var a account
		var kdf string
		if err := rows.Scan(&a.ID, &a.Email, &kdf, &a.WrappedMasterPW, &a.WrappedMasterRecovery, &a.WrappedPrivkey, &a.Items); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(kdf), &a.KDF); err != nil {
			return nil, errors.New("unreadable password-hashing parameters for " + clean(a.Email))
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

type itemRow struct {
	ID, Kind             string
	Size, Count, Created int64
	Trashed              sql.NullInt64
	WrappedKey, MetaEnc  string
}

func (b *backupDir) items(userID string) ([]itemRow, error) {
	rows, err := b.db.Query(`SELECT id,kind,size_bytes,segment_count,created_at,trashed_at,COALESCE(wrapped_item_key,''),COALESCE(meta_enc,'')
		FROM items WHERE user_id=? AND state='ready' ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []itemRow
	for rows.Next() {
		var r itemRow
		if err := rows.Scan(&r.ID, &r.Kind, &r.Size, &r.Count, &r.Created, &r.Trashed, &r.WrappedKey, &r.MetaEnc); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type albumRow struct {
	ID, NameEnc string
	ItemIDs     []string
}

func (b *backupDir) albums(userID string) ([]albumRow, error) {
	rows, err := b.db.Query(`SELECT id,name_enc FROM albums WHERE user_id=? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	var out []albumRow
	for rows.Next() {
		var a albumRow
		if err := rows.Scan(&a.ID, &a.NameEnc); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, a)
	}
	rows.Close()
	for i := range out {
		r, err := b.db.Query(`SELECT item_id FROM album_items WHERE album_id=? ORDER BY added_at`, out[i].ID)
		if err != nil {
			return nil, err
		}
		for r.Next() {
			var id string
			if r.Scan(&id) == nil {
				out[i].ItemIDs = append(out[i].ItemIDs, id)
			}
		}
		r.Close()
	}
	return out, nil
}

func (b *backupDir) segmentPath(itemID string, n int64) string {
	return filepath.Join(b.blobs, itemID[:2], itemID, fmt.Sprintf("seg%06d", n))
}
