package main

// Requests that overlap with another change to the same account or item. Each test puts the other change at the
// worst moment and checks that the invariant still holds.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// hookReader runs hook once, when the handler starts reading the body: the moment a slow upload is still streaming.
type hookReader struct {
	r    io.Reader
	hook func()
}

func (h *hookReader) Read(p []byte) (int, error) {
	if h.hook != nil {
		h.hook()
		h.hook = nil
	}
	return h.r.Read(p)
}

// putDuring sends body straight into the handler chain and runs hook while the body is being read.
func (c *client) putDuring(path string, body []byte, hook func()) int {
	req := httptest.NewRequest("PUT", path, &hookReader{bytes.NewReader(body), hook})
	req.ContentLength = int64(len(body))
	req.Host = "example.org"
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-CSRF-Token", c.csrf)
	req.Header.Set("Cookie", c.cookieHeader())
	rec := httptest.NewRecorder()
	c.e.app.handler().ServeHTTP(rec, req)
	return rec.Code
}

func TestRecoveryTicketDiesWithARotationThatOverlapsIt(t *testing.T) {
	e := newEnv(t)
	_, ab := e.setupAdmin("admin@x.org")
	c := e.client()
	_, out := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": ab["recovery_verifier"].(string)}, false)
	ticket, _ := out["ticket"].(string)
	if ticket == "" {
		t.Fatal("no ticket")
	}
	// the rotation commits after the ticket was checked but its revocation ran before the ticket was stored
	nk := bundle()
	rh, _ := hashSecret(nk["recovery_verifier"].(string))
	e.app.db.Exec(`UPDATE users SET recovery_hash=? WHERE email='admin@x.org'`, rh)
	fin := map[string]any{"ticket": ticket, "new_auth": rb(32), "new_kdf": nk["kdf"], "new_wrapped_master_pw": nk["wrapped_master_pw"], "new_wrapped_master_recovery": nk["wrapped_master_recovery"], "new_recovery_verifier": rb(32)}
	if code, _ := c.do("POST", "/api/auth/recover/finish", fin, false); code != 403 {
		t.Fatalf("a ticket opened with the old recovery key finished after the rotation: %d", code)
	}
	if code, _ := e.client().do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": ab["auth"].(string)}, false); code != 200 {
		t.Fatal("the account was changed anyway")
	}
}

func TestFailedSegmentWriteDoesNotStallThePool(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.newItem(admin, 10)
	// one connection: a handler that asks for a second one while its transaction holds the first waits forever
	e.app.db.SetMaxOpenConns(1)
	defer e.app.db.SetMaxOpenConns(4)
	done := make(chan int, 1)
	go func() {
		done <- admin.putDuring("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))), func() {
			e.app.db.Exec(`DELETE FROM items WHERE id=?`, id) // deleted while the body streams
		})
	}()
	select {
	case code := <-done:
		if code != 500 {
			t.Fatalf("segment for a deleted item: %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the segment handler is stuck waiting for a database connection")
	}
	if _, err := os.Stat(e.app.itemDir(id)); !os.IsNotExist(err) {
		t.Fatal("the deleted item's files were left behind")
	}
}

func TestPreviewThatArrivesAfterFinalizeIsNotStored(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.newItem(admin, 10)
	first := randBytes(1000)
	if code, _ := admin.put("/api/items/"+id+"/preview", first); code != 200 {
		t.Fatalf("preview: %d", code)
	}
	finalize := func() { e.app.db.Exec(`UPDATE items SET state='ready' WHERE id=?`, id) }
	if code := admin.putDuring("/api/items/"+id+"/preview", randBytes(3000), finalize); code != 409 {
		t.Fatalf("preview after finalize: %d", code)
	}
	got, err := os.ReadFile(filepath.Join(e.app.itemDir(id), "preview"))
	if err != nil || !bytes.Equal(got, first) {
		t.Fatal("a preview that was refused replaced the counted one")
	}
	var counted int64
	e.app.db.QueryRow(`SELECT preview_bytes FROM items WHERE id=?`, id).Scan(&counted)
	if counted != int64(len(got)) {
		t.Fatalf("preview on disk %d bytes, counted %d", len(got), counted)
	}
	// and nothing is left over from the refused body
	ents, _ := os.ReadDir(e.app.itemDir(id))
	for _, d := range ents {
		if d.Name() != "preview" {
			t.Fatalf("left behind: %s", d.Name())
		}
	}
}

// postDuring sends a JSON body straight into the handler chain and runs hook while the body is being read: the
// request has already passed the session check at that point.
func (c *client) postDuring(path string, body any, hook func()) int {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", path, &hookReader{bytes.NewReader(b), hook})
	req.ContentLength = int64(len(b))
	req.Host = "example.org"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", c.csrf)
	req.Header.Set("Cookie", c.cookieHeader())
	rec := httptest.NewRecorder()
	c.e.app.handler().ServeHTTP(rec, req)
	return rec.Code
}

func TestRecoveryKeyChangeDiesWithTheSessionThatStartedIt(t *testing.T) {
	for name, meanwhile := range map[string]string{
		"recovery or sign-out ended the session": `DELETE FROM sessions`,
		"the password changed":                   `UPDATE users SET auth_hash='changed'`,
		"the account was disabled":               `UPDATE users SET status='disabled'`,
	} {
		e := newEnv(t)
		admin, ab := e.setupAdmin("admin@x.org")
		var before string
		e.app.db.QueryRow(`SELECT recovery_hash FROM users`).Scan(&before)
		nk := bundle()
		body := map[string]any{"current_auth": ab["auth"], "wrapped_master_recovery": nk["wrapped_master_recovery"], "recovery_verifier": nk["recovery_verifier"]}
		if code := admin.postDuring("/api/auth/recovery-key", body, func() { e.app.db.Exec(meanwhile) }); code == 200 {
			t.Errorf("%s: the recovery key was replaced anyway", name)
		}
		var after string
		e.app.db.QueryRow(`SELECT recovery_hash FROM users`).Scan(&after)
		if after != before {
			t.Errorf("%s: recovery_hash changed", name)
		}
	}
}

// Adding to an album while other writes run (a Mac or phone indexing at the same time) must not fail with
// "database is locked": transactions begin immediate and wait for the lock.
func TestAlbumWritesUnderConcurrentWrites(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	ids := make([]string, 6)
	for i := range ids {
		ids[i] = e.newItem(admin, 10)
		admin.put("/api/items/"+ids[i]+"/segments/0", randBytes(int(cipherLen(10))))
		if code, _ := admin.do("POST", "/api/items/"+ids[i]+"/finalize", finalizeBody(), true); code != 200 {
			t.Fatalf("finalize: %d", code)
		}
	}
	album := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"
	if code, _ := admin.do("POST", "/api/albums", map[string]any{"id": album, "name_enc": rb(80)}, true); code != 201 {
		t.Fatalf("album: %d", code)
	}
	done := make(chan int, 64)
	for i := 0; i < 32; i++ {
		go func(i int) {
			if i%2 == 0 {
				code, _ := admin.do("PUT", "/api/albums/"+album+"/items", map[string]any{"item_ids": ids}, true)
				done <- code
			} else {
				code, _ := admin.do("PUT", "/api/items/"+ids[i%len(ids)]+"/index", map[string]any{"data_enc": rb(200), "model": "laionb32/1"}, true)
				done <- code
			}
		}(i)
	}
	for i := 0; i < 32; i++ {
		if code := <-done; code != 200 {
			t.Fatalf("a write failed under concurrency: %d", code)
		}
	}
}
