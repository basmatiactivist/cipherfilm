package main

import (
	"database/sql"
	"encoding/json"
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

// Edits made in the apps (docs/EDITING.md) and the original's SHA-256 (docs/CRYPTO.md) add optional fields to the
// metadata: the tool still reads it, exports the original (never the edit) and files it under the date the person set.
func TestMetadataWithEditsStillReads(t *testing.T) {
	raw := []byte(`{"name":"a.jpg","mime":"image/jpeg","size":10,"lastModified":1,"capture_ts":1714565000000,` +
		`"gps":{"lat":1,"lon":2},"edit":{"rot":90,"crop":{"x":0.1,"y":0,"w":0.5,"h":1},"v":"ab12"},"orig":{"capture_ts":1,"gps":null},` +
		`"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}`)
	var m meta
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unreadable: %v", err)
	}
	if m.Name != "a.jpg" || m.Size != 10 || m.CaptureTS != 1714565000000 {
		t.Fatalf("read %+v", m)
	}
}

// A case-insensitive volume (APFS, NTFS) folds more than lowercasing does: a second item whose name differs from an
// earlier one only by such a character, or by its normalization, gets its own file instead of replacing the first.
func TestNamesThatFoldTogetherGetTheirOwnFile(t *testing.T) {
	const a, b = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	dir := filepath.Join("Library", "2024", "2024-05")
	for _, pair := range [][2]string{
		{"Screenshot.png", "screenshot.PNG"},
		{"Screenshot.png", "ſcreenshot.png"}, // long s folds to s
		{"Σα.jpg", "σα.jpg"},                 // capital sigma and small sigma
		{"σα.jpg", "ςα.jpg"},                 // small sigma and final sigma
		{"Café.jpg", "CAFÉ.jpg"},            // composed and decomposed é, different case
		{"Straße.jpg", "STRASSE.jpg"},        // ß folds to ss
		{"Ångström.jpg", "ångström.jpg"},     // Angstrom sign and å
	} {
		used := map[string]bool{}
		first := freeName(filepath.Join(dir, pair[0]), a, used)
		second := freeName(filepath.Join(dir, pair[1]), b, used)
		if first != filepath.Join(dir, pair[0]) {
			t.Fatalf("%q: the first item was renamed to %q", pair[0], first)
		}
		if nameKey(first) == nameKey(second) || !strings.HasSuffix(strings.TrimSuffix(second, filepath.Ext(second)), "-bbbbbb") {
			t.Fatalf("%q after %q: got %q, which the volume takes for the same file", pair[1], pair[0], second)
		}
	}
	// names that are really different keep their own name
	used := map[string]bool{}
	freeName(filepath.Join(dir, "a.jpg"), a, used)
	if got := freeName(filepath.Join(dir, "b.jpg"), b, used); got != filepath.Join(dir, "b.jpg") {
		t.Fatalf("got %q", got)
	}
	// nor may an item's temp file land on an earlier item's file
	used = map[string]bool{}
	freeName(filepath.Join(dir, "x.jpg.partial"), a, used)
	if got := freeName(filepath.Join(dir, "ſ.JPG"), b, used); got != filepath.Join(dir, "ſ.JPG") {
		t.Fatalf("got %q", got)
	}
	if got := freeName(filepath.Join(dir, "X.JPG"), b, used); got != filepath.Join(dir, "X-bbbbbb.JPG") {
		t.Fatalf("got %q", got)
	}
}
