package main

import (
	"database/sql"
	"os"
	"strings"
	"path/filepath"
	"testing"
	"time"
)

func TestReadSegmentRejectsUntrustedFiles(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good")
	os.WriteFile(good, make([]byte, 100), 0o600)
	if _, err := readSegment(good, 100); err != nil {
		t.Fatalf("regular file of the right size: %v", err)
	}
	if _, err := readSegment(good, 99); err == nil {
		t.Fatal("wrong size accepted")
	}
	link := filepath.Join(dir, "link")
	os.Symlink(good, link)
	if _, err := readSegment(link, 100); err == nil {
		t.Fatal("symlink accepted")
	}
	if _, err := readSegment(dir, 0); err == nil {
		t.Fatal("directory accepted")
	}
}

func TestCleanRemovesTerminalEscapes(t *testing.T) {
	if got := clean("a\x1b[31mred\x07\n"); got != "a?[31mred??" {
		t.Fatalf("clean = %q", got)
	}
}

func TestHostileKDFParametersAreRejected(t *testing.T) {
	salt := "AAAAAAAAAAAAAAAAAAAAAA"
	for _, p := range []kdfParams{{Alg: "argon2id13", V: 1, Ops: 1 << 32, Mem: 1 << 26, Salt: salt}, {Alg: "argon2id13", V: 1, Ops: 3, Mem: 4 << 30, Salt: salt}, {Alg: "argon2id13", V: 1, Ops: 0, Mem: 1 << 26, Salt: salt}} {
		if _, err := passwordKEK("x", p); err == nil {
			t.Fatalf("params %+v accepted", p)
		}
	}
}

func TestNewestDatabaseWins(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "blobs"), 0o755)
	os.MkdirAll(filepath.Join(root, "backup"), 0o755)
	live, snap := filepath.Join(root, "app.db"), filepath.Join(root, "backup", "app.db")
	os.WriteFile(live, []byte("x"), 0o600)
	os.WriteFile(snap, []byte("x"), 0o600)
	old, recent := time.Now().Add(-48*time.Hour), time.Now()
	os.Chtimes(snap, old, old)
	os.Chtimes(live, recent, recent)
	if got, _, err := findBackup(root); err != nil || got != live {
		t.Fatalf("live database is newer, got %q (%v)", got, err)
	}
	os.Chtimes(snap, recent.Add(time.Hour), recent.Add(time.Hour))
	if got, _, err := findBackup(root); err != nil || got != snap {
		t.Fatalf("snapshot is newer, got %q (%v)", got, err)
	}
}

func TestTextFromTheBackupIsCleanedInErrors(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "blobs"), 0o700)
	db, err := sql.Open("sqlite", "file:"+filepath.Join(root, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.Exec(`CREATE TABLE users (id TEXT, email TEXT, kdf TEXT, wrapped_master_pw TEXT, wrapped_master_recovery TEXT, created_at INTEGER)`)
	db.Exec(`CREATE TABLE items (id TEXT, user_id TEXT, state TEXT)`)
	db.Exec(`INSERT INTO users VALUES ('u', 'v@x.org'||char(27)||']0;TITLE'||char(7), 'not-json', '', '', 0)`)
	db.Close()
	b, err := openBackup(root)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	_, err = b.accounts()
	if err == nil || strings.ContainsAny(err.Error(), "\x1b\x07") {
		t.Fatalf("error = %q", err)
	}
}
