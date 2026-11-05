package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
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

func TestSafeNameDropsControlCharacters(t *testing.T) {
	if got := safeName("a\x1b\x7f\u009bb.jpg", "x"); got != "a___b.jpg" {
		t.Fatalf("safeName = %q", got)
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

func TestOutputStaysInsideTheOutFolder(t *testing.T) {
	out := filepath.Join("work", "out")
	for _, p := range []string{"Library/2024/2024-01/a.jpg", "Albums/x"} {
		if !within(out, filepath.Join(out, p)) {
			t.Fatalf("%s rejected", p)
		}
	}
	for _, p := range []string{"", "..", "../x", "Library/../../x", "./../../../../././escaped-file-b"} {
		if within(out, filepath.Join(out, p)) {
			t.Fatalf("%q accepted", p)
		}
	}
}

// Ids in the database are not trusted: one that is not 32 lowercase hex characters must not reach a key, a blob path
// or the output folder, even if it has the right length.
func TestMalformedIdsAreRefused(t *testing.T) {
	work := t.TempDir()
	root, out := filepath.Join(work, "a", "b", "c", "d", "root"), filepath.Join(work, "o", "out")
	os.MkdirAll(filepath.Join(root, "blobs"), 0o700)
	os.MkdirAll(out, 0o755)
	db, err := sql.Open("sqlite", "file:"+filepath.Join(root, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.Exec(`CREATE TABLE items (id TEXT, user_id TEXT, kind TEXT, size_bytes INTEGER, segment_count INTEGER, created_at INTEGER,
		trashed_at INTEGER, wrapped_item_key TEXT, meta_enc TEXT, state TEXT)`)
	db.Exec(`CREATE TABLE albums (id TEXT, user_id TEXT, name_enc TEXT, created_at INTEGER)`)
	db.Exec(`CREATE TABLE album_items (album_id TEXT, item_id TEXT, added_at INTEGER)`)
	bad := []string{"./../../../../newdir/escaped-a-1", "./../../../../././escaped-file-b", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef"}
	for _, id := range bad {
		db.Exec(`INSERT INTO items VALUES (?, 'u', 'image', 5, 1, 0, NULL, 'AAAA', 'AAAA', 'ready')`, id)
		db.Exec(`INSERT INTO albums VALUES (?, 'u', 'AAAA', 0)`, id)
	}
	db.Close()
	b, err := openBackup(root)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	items, err := b.items("u")
	if err != nil || len(items) != len(bad) {
		t.Fatalf("items: %d %v", len(items), err)
	}
	keys := &keyRing{master: make([]byte, 32)}
	for _, it := range items {
		if _, _, err := restoreItem(b, it, keys, options{out: out}, map[string]bool{}); err == nil || err.Error() != "unexpected item id" {
			t.Fatalf("%q: %v", it.ID, err)
		}
	}
	if err := export(b, &account{ID: "u"}, make([]byte, 32), options{out: out}); err == nil {
		t.Fatal("export reported success")
	}
	entries, _ := os.ReadDir(filepath.Join(work, "o"))
	if len(entries) != 1 || entries[0].Name() != "out" {
		t.Fatalf("something was written next to the out folder: %v", entries)
	}
	if albums, _ := os.ReadDir(filepath.Join(out, "Albums")); len(albums) != 0 {
		t.Fatalf("album folders made for malformed ids: %v", albums)
	}
}
