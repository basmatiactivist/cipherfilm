package main

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	filepath.Walk(from, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		rel, _ := filepath.Rel(from, p)
		dst := filepath.Join(to, rel)
		if info.IsDir() {
			return os.MkdirAll(dst, 0o700)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		return os.WriteFile(dst, b, 0o600)
	})
}

func TestBackupRestoreRoundTrip(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	i1 := e.readyItem(admin)
	e.readyItem(admin)
	trashed := e.readyItem(admin)
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{trashed}}, true)
	alb := albumBody()
	admin.do("POST", "/api/albums", alb, true)
	admin.do("PUT", "/api/albums/"+alb["id"].(string)+"/items", map[string]any{"item_ids": []string{i1}}, true)

	// 1. snapshot the database while the app is "running", 2. copy blobs, as scripts/backup.sh does
	if err := runBackup(e.app.dataDir); err != nil {
		t.Fatal(err)
	}
	// a change made after the snapshot must not be part of the restored state
	e.readyItem(admin)

	restored := t.TempDir()
	os.MkdirAll(filepath.Join(restored, "blobs"), 0o700)
	copyTree(t, filepath.Join(e.app.dataDir, "blobs"), filepath.Join(restored, "blobs"))
	os.Rename(filepath.Join(e.app.dataDir, "backup", "app.db"), filepath.Join(restored, "app.db"))
	os.Rename(filepath.Join(e.app.dataDir, "backup", "secret"), filepath.Join(restored, "secret"))

	res, err := runCheck(restored)
	if err != nil {
		t.Fatal(err)
	}
	if res.Integrity != "ok" || res.Users != 1 || res.Items != 2 || res.Trashed != 1 || len(res.MissingBlobs) != 0 {
		t.Fatalf("restored state: %+v", res)
	}
	// the restored data directory is a working app: the admin can still sign in with the same credentials
	app2, err := newApp(restored)
	if err != nil {
		t.Fatal(err)
	}
	defer app2.db.Close()
	u, err := app2.userByEmail("admin@x.org")
	if err != nil || !verifySecret(u.AuthHash, ab["auth"].(string)) {
		t.Fatal("credentials do not survive restore")
	}
	if string(app2.secret) != string(e.app.secret) {
		t.Fatal("secret not restored")
	}
}

func TestFailedSnapshotKeepsThePreviousOne(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	if err := runBackup(e.app.dataDir); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(e.app.dataDir, "backup", "app.db"))
	// the secret can't be copied: the run fails after the new database snapshot was written
	os.Rename(filepath.Join(e.app.dataDir, "secret"), filepath.Join(e.app.dataDir, "secret.away"))
	if err := runBackup(e.app.dataDir); err == nil {
		t.Fatal("backup without a secret succeeded")
	}
	os.Rename(filepath.Join(e.app.dataDir, "secret.away"), filepath.Join(e.app.dataDir, "secret"))
	after, err := os.ReadFile(filepath.Join(e.app.dataDir, "backup", "app.db"))
	if err != nil || string(after) != string(before) {
		t.Fatal("a failed run replaced or removed the previous snapshot")
	}
	for _, leftover := range []string{"backup.new", "backup.old"} {
		if _, err := os.Stat(filepath.Join(e.app.dataDir, leftover)); err == nil {
			t.Fatalf("%s left behind", leftover)
		}
	}
	// the snapshot is a plain database file: the integrity check left no -wal or -shm next to it
	if err := runBackup(e.app.dataDir); err != nil {
		t.Fatal(err)
	}
	names, _ := os.ReadDir(filepath.Join(e.app.dataDir, "backup"))
	if len(names) != 2 {
		t.Fatalf("backup/ holds %d files, want app.db and secret", len(names))
	}
}

func TestBackupReportShowsInServerStatus(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	status := func() map[string]any { _, s := admin.do("GET", "/api/admin/status", nil, true); return s }
	if s := status(); s["backup_ok_at"].(float64) != 0 || s["backup_failed_at"].(float64) != 0 {
		t.Fatalf("fresh server reports a backup: %v", s)
	}
	if err := runBackupReport(e.app.dataDir, []string{"failed", "upload"}); err != nil {
		t.Fatal(err)
	}
	if s := status(); s["backup_failed_at"].(float64) == 0 || s["backup_failed_in"] != "upload" {
		t.Fatalf("failure not reported: %v", s)
	}
	if err := runBackupReport(e.app.dataDir, []string{"ok"}); err != nil {
		t.Fatal(err)
	}
	if s := status(); s["backup_ok_at"].(float64) == 0 {
		t.Fatalf("success not reported: %v", s)
	}
	for _, bad := range [][]string{{}, {"failed"}, {"failed", "webdav://user:pw@host"}, {"ok", "x"}} {
		if runBackupReport(e.app.dataDir, bad) == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	// only administrators see it
	tok := e.invite(admin, "bob@x.org")
	bob, _ := e.acceptInvite(tok)
	if code, _ := bob.do("GET", "/api/admin/status", nil, true); code != 404 { // admin routes look absent to others
		t.Fatal("non-admin reads server status")
	}
}

func TestCheckFindsMissingBlobs(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.readyItem(admin)
	os.RemoveAll(e.app.itemDir(id))
	r, err := runCheck(e.app.dataDir)
	if err != nil || len(r.MissingBlobs) != 1 || r.MissingBlobs[0] != id {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestClientIPUsesTheProxyAppendedEntry(t *testing.T) {
	a := &App{trustProxy: true}
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 203.0.113.9") // forged first entry, real last entry
	r.RemoteAddr = "10.0.0.2:1234"
	if got := a.clientIP(r); got != "203.0.113.9" {
		t.Fatalf("got %s", got)
	}
	a.trustProxy = false
	if got := a.clientIP(r); got != "10.0.0.2" {
		t.Fatalf("untrusted: %s", got)
	}
}

func TestOverlappingBackupsDoNotShareTheirWork(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	if err := runBackup(e.app.dataDir); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(e.app.dataDir, "backup", "app.db"))
	held, err := os.OpenFile(filepath.Join(e.app.dataDir, "backup.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(held.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	if err := runBackup(e.app.dataDir); err == nil {
		t.Fatal("a second backup ran while one was running")
	}
	held.Close()
	if after, _ := os.ReadFile(filepath.Join(e.app.dataDir, "backup", "app.db")); string(after) != string(before) {
		t.Fatal("the refused run touched the snapshot")
	}
	if err := runBackup(e.app.dataDir); err != nil {
		t.Fatalf("after the first run ended: %v", err)
	}
	// an empty file passes SQLite's integrity check; it must not pass as a snapshot
	empty := filepath.Join(t.TempDir(), "app.db")
	os.WriteFile(empty, nil, 0o600)
	if checkSnapshot(empty) == nil {
		t.Fatal("an empty database passed as a snapshot")
	}
}

// A device signed out on purpose after the snapshot must still be told so after a restore of that snapshot: the
// sign-out records are taken over from the replaced database, which restore.sh leaves in .previous/.
func TestRestoreKeepsLaterSignOuts(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	phone := e.login("admin@x.org", ab)
	if err := runBackup(e.app.dataDir); err != nil {
		t.Fatal(err)
	}
	for _, s := range sessionList(t, admin) {
		if s["current"] != true {
			admin.do("DELETE", "/api/me/sessions/"+s["id"].(string), nil, true)
		}
	}
	restore := func(prev func(dir string)) string {
		dir := t.TempDir()
		os.MkdirAll(filepath.Join(dir, "blobs"), 0o700)
		os.MkdirAll(filepath.Join(dir, ".previous"), 0o700)
		prev(filepath.Join(dir, ".previous"))
		for _, f := range []string{"app.db", "secret"} {
			if err := copyFile(filepath.Join(e.app.dataDir, "backup", f), filepath.Join(dir, f)); err != nil {
				t.Fatal(err)
			}
		}
		if err := runAfterRestore(dir); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	dir := restore(func(prev string) {
		for _, f := range []string{"app.db", "app.db-wal", "app.db-shm"} {
			if _, err := os.Stat(filepath.Join(e.app.dataDir, f)); err == nil {
				copyFile(filepath.Join(e.app.dataDir, f), filepath.Join(prev, f))
			}
		}
	})
	app2, err := newApp(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer app2.db.Close()
	srv := httptest.NewTLSServer(app2.handler())
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/api/items", nil)
	resp, err := phone.c.Do(req) // the cookie jar ignores the port: the phone's session cookie goes along
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 401 || resp.Header.Get("X-CF-Session") != "revoked" {
		t.Fatalf("signed-out device not told after the restore: %d %q", resp.StatusCode, resp.Header.Get("X-CF-Session"))
	}
	// a replaced database from before sign-outs were remembered is no obstacle
	restore(func(prev string) {
		db, err := sql.Open("sqlite", filepath.Join(prev, "app.db"))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		db.Exec(`CREATE TABLE users(id TEXT)`)
	})
}
