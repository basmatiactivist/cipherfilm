package main

// Ways someone could lose their own data through normal use, an interruption or a race. Each test was first a
// reproduction of the loss; now it pins the fix.

import (
	"bytes"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// dropsAtEOF is a request body whose connection breaks after the given bytes.
type dropsAtEOF struct{ r io.Reader }

func (f *dropsAtEOF) Read(p []byte) (int, error) {
	n, err := f.r.Read(p)
	if err == io.EOF {
		return n, errors.New("connection reset by peer")
	}
	return n, err
}

func (c *client) cookieHeader() string {
	req, _ := http.NewRequest("GET", c.e.srv.URL+"/", nil)
	out := ""
	for _, ck := range c.c.Jar.Cookies(req.URL) {
		if out != "" {
			out += "; "
		}
		out += ck.Name + "=" + ck.Value
	}
	return out
}

// putBroken sends a body that dies part-way, straight into the real handler chain.
func (c *client) putBroken(path string, partial []byte, declared int64) int {
	req := httptest.NewRequest("PUT", path, &dropsAtEOF{bytes.NewReader(partial)})
	req.ContentLength = declared
	req.Host = "example.org"
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-CSRF-Token", c.csrf)
	req.Header.Set("Cookie", c.cookieHeader())
	rec := httptest.NewRecorder()
	c.e.app.handler().ServeHTTP(rec, req)
	return rec.Code
}

func TestBrokenRetryKeepsTheStoredSegment(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.newItem(admin, int64(segPlain+10))
	seg0 := randBytes(int(cipherLen(segPlain)))
	seg1 := randBytes(int(cipherLen(10)))
	// attempt 1 is stored (the phone never saw the 200); the retry's connection breaks half-way
	if code, _ := admin.put("/api/items/"+id+"/segments/0", seg0); code != 200 {
		t.Fatalf("seg0: %d", code)
	}
	if code := admin.putBroken("/api/items/"+id+"/segments/0", seg0[:len(seg0)/2], int64(len(seg0))); code != 400 {
		t.Fatalf("broken retry: %d", code)
	}
	// a wrong-size retry must not replace it either
	if code, _ := admin.put("/api/items/"+id+"/segments/0", seg0[:100]); code != 400 {
		t.Fatalf("short retry: %d", code)
	}
	if got, err := os.ReadFile(filepath.Join(e.app.itemDir(id), "seg000000")); err != nil || !bytes.Equal(got, seg0) {
		t.Fatal("the stored segment was removed or replaced by a failed retry")
	}
	admin.put("/api/items/"+id+"/segments/1", seg1)
	if code, out := admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d %v", code, out)
	}
	var stored int64
	e.app.db.QueryRow(`SELECT stored_bytes FROM items WHERE id=?`, id).Scan(&stored)
	if want := int64(len(seg0)+len(seg1)) + finalizeCharge(int64(len(seg0)), int64(len(seg1))); stored != want {
		t.Fatalf("stored_bytes=%d, want %d: retries were counted twice", stored, want)
	}
	if r, _ := checkDB(e.app.db, e.app.dataDir); len(r.MissingBlobs) != 0 {
		t.Fatalf("finished item misses files: %v", r.MissingBlobs)
	}
}

func TestFinalizeRefusesMissingSegmentFilesAndAsksForThemAgain(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.newItem(admin, 10)
	seg := randBytes(int(cipherLen(10)))
	admin.put("/api/items/"+id+"/segments/0", seg)
	os.Remove(filepath.Join(e.app.itemDir(id), "seg000000")) // the row says it arrived, the file is gone
	if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 409 {
		t.Fatalf("finalize with a missing file: %d, want 409", code)
	}
	if _, st := admin.do("GET", "/api/items/"+id+"/upload", nil, false); len(st["received"].([]any)) != 0 {
		t.Fatalf("the missing part is still listed as received: %v", st["received"])
	}
	admin.put("/api/items/"+id+"/segments/0", seg) // resume sends it again
	if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize after the re-upload: %d", code)
	}
}

func TestPurgeNeedsTheItems(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	var ids []string
	for i := 0; i < 3; i++ {
		id := e.readyItem(admin)
		ids = append(ids, id)
	}
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": ids}, true)
	for _, body := range []map[string]any{{"item_ids": []string{}}, {}} {
		if code, _ := admin.do("POST", "/api/trash/purge", body, true); code != 400 {
			t.Fatalf("purge %v: %d, want 400", body, code)
		}
	}
	_, out := admin.do("POST", "/api/trash/purge", map[string]any{"item_ids": ids[:1]}, true)
	var left int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM items WHERE trashed_at IS NOT NULL`).Scan(&left)
	if out["removed"].(float64) != 1 || left != 2 {
		t.Fatalf("removed %v, %d left in the trash", out["removed"], left)
	}
}

func TestCleanupKeepsFilesWhenTheDatabaseFails(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.readyItem(admin)
	live := e.app.db
	broken, _ := sql.Open("sqlite", "file:"+filepath.Join(e.app.dataDir, "app.db"))
	broken.Close() // every query on it fails, as a busy or failing database would
	e.app.db = broken
	e.app.now = func() time.Time { return time.Now().Add(orphanGrace + time.Minute) }
	e.app.sweepOrphans()
	e.app.cleanupIfGone(id)
	e.app.db = live
	if _, err := os.Stat(filepath.Join(e.app.itemDir(id), "seg000000")); err != nil {
		t.Fatal("a failed query made the cleanup delete a live item's files")
	}
}

func TestCleanupRechecksBeforeDeleting(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.readyItem(admin)
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{id}}, true)
	// the purge selected it as expired, then it was restored before the delete ran
	if code, _ := admin.do("POST", "/api/items/restore", map[string]any{"item_ids": []string{id}}, true); code != 200 {
		t.Fatalf("restore: %d", code)
	}
	e.app.now = func() time.Time { return time.Now().Add(trashRetention + time.Hour) }
	cutoff := e.app.now().Add(-trashRetention).Unix()
	res, err := e.app.db.Exec(`DELETE FROM items WHERE id=? AND trashed_at IS NOT NULL AND trashed_at < ?`, id, cutoff)
	if rowsAffected(res, err) != 0 {
		t.Fatal("a restored item matched the expired-trash delete")
	}
	e.app.purgeExpiredTrash()
	e.app.sweepStale()
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM items WHERE id=?`, id).Scan(&n)
	if n != 1 {
		t.Fatal("cleanup deleted an item that is no longer in the trash")
	}
}

func TestConcurrentPasswordChangesOnlyOneWins(t *testing.T) {
	e := newEnv(t)
	a, ab := e.setupAdmin("admin@x.org")
	b := e.client()
	b.do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": ab["auth"].(string)}, false)
	na, nb := bundle(), bundle()
	body := func(n map[string]any) map[string]any {
		return map[string]any{"current_auth": ab["auth"], "new_auth": n["auth"], "new_kdf": n["kdf"], "new_wrapped_master_pw": n["wrapped_master_pw"]}
	}
	for i := 0; i < 20; i++ { // the race needs both requests past the password check before either writes
		var wg sync.WaitGroup
		var ca, cb int
		wg.Add(2)
		go func() { defer wg.Done(); ca, _ = a.do("POST", "/api/auth/password", body(na), true) }()
		go func() { defer wg.Done(); cb, _ = b.do("POST", "/api/auth/password", body(nb), true) }()
		wg.Wait()
		if ca == 200 && cb == 200 {
			t.Fatal("both password changes succeeded: the later one silently replaced the earlier")
		}
		if ca == 200 || cb == 200 {
			return
		}
	}
}

func TestAfterRestoreKeepsTheTrashAndEndsSessions(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.readyItem(admin)
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{id}}, true)
	// the backup is restored long after the item was trashed
	e.app.db.Exec(`UPDATE items SET trashed_at=? WHERE id=?`, time.Now().Add(-40*24*time.Hour).Unix(), id)
	if err := runAfterRestore(e.app.dataDir); err != nil {
		t.Fatal(err)
	}
	e.app.purgeExpiredTrash() // the cleanup runs as soon as the restored app starts
	var n, sessions int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM items WHERE id=?`, id).Scan(&n)
	e.app.db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessions)
	if n != 1 {
		t.Fatal("the restored trash was purged at once")
	}
	if sessions != 0 {
		t.Fatalf("%d sessions survived the restore", sessions)
	}
}
