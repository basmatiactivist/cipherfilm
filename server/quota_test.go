package main

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestAuxUploadsCountTowardTheQuota(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.app.db.Exec(`UPDATE users SET quota_bytes=1000 WHERE email='bob@x.org'`)
	// a tiny quota cannot hold even one maximum-size thumbnail: refused up front, nothing written
	id := e.newItem(bob, 0)
	if code, _ := bob.put("/api/items/"+id+"/thumb", randBytes(maxThumbBytes)); code != 413 {
		t.Fatalf("thumb over quota: %d", code)
	}
	if code, _ := bob.put("/api/items/"+id+"/preview", randBytes(1<<20)); code != 413 {
		t.Fatalf("preview over quota: %d", code)
	}
	var stored int64
	e.app.db.QueryRow(`SELECT stored_bytes FROM items WHERE id=?`, id).Scan(&stored)
	if stored != 0 {
		t.Fatalf("stored_bytes %d after refused uploads", stored)
	}
	// with room, aux data is counted once; a replacement costs only the difference
	e.app.db.Exec(`UPDATE users SET quota_bytes=? WHERE email='bob@x.org'`, 10<<20)
	if code, _ := bob.put("/api/items/"+id+"/thumb", randBytes(1000)); code != 200 {
		t.Fatalf("thumb: %d", code)
	}
	if code, _ := bob.put("/api/items/"+id+"/thumb", randBytes(1500)); code != 200 {
		t.Fatalf("thumb replace: %d", code)
	}
	e.app.db.QueryRow(`SELECT stored_bytes FROM items WHERE id=?`, id).Scan(&stored)
	if stored != 1500 {
		t.Fatalf("replacing a thumb inflated stored_bytes to %d", stored)
	}
}

func TestOpenUploadsAreCapped(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	for i := 0; i < maxOpenUploads; i++ {
		e.newItem(bob, 0)
	}
	if code, _ := bob.do("POST", "/api/items", map[string]any{"kind": "image", "size": 0, "segment_count": 1}, true); code != 429 {
		t.Fatalf("open upload cap not enforced: %d", code)
	}
}

// Held-body concurrent uploads must not all pass the quota check before any is counted.
func TestConcurrentUploadsCannotExceedTheQuota(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.app.db.Exec(`UPDATE users SET quota_bytes=? WHERE email='bob@x.org'`, cipherLen(10)+9) // room for exactly one segment
	ids := make([]string, 4)
	for i := range ids {
		code, out := bob.do("POST", "/api/items", map[string]any{"kind": "image", "size": 10, "segment_count": 1}, true)
		if code != 201 && code != 413 {
			t.Fatalf("create: %d", code)
		}
		if code == 201 {
			ids[i] = out["id"].(string)
		}
	}
	var wg sync.WaitGroup
	codes := make([]int, len(ids))
	for i, id := range ids {
		if id == "" {
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			pr, pw := io.Pipe()
			req, _ := http.NewRequest("PUT", e.srv.URL+"/api/items/"+id+"/segments/0", pr)
			req.ContentLength = cipherLen(10)
			req.Header.Set("Content-Type", "application/octet-stream")
			req.Header.Set("X-CSRF-Token", bob.csrf)
			body := randBytes(int(cipherLen(10)))
			go func() { pw.Write(body[:5]); time.Sleep(400 * time.Millisecond); pw.Write(body[5:]); pw.Close() }()
			resp, err := bob.c.Do(req)
			if err == nil {
				resp.Body.Close()
				codes[i] = resp.StatusCode
			}
		}(i, id)
	}
	wg.Wait()
	ok := 0
	for _, c := range codes {
		if c == 200 {
			ok++
		}
	}
	if ok > 1 {
		t.Fatalf("%d concurrent uploads fit a quota that holds one: %v", ok, codes)
	}
}

func TestOrphanBlobDirectoriesAreSwept(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	oldID, newID := randID(), randID()
	for _, id := range []string{oldID, newID} {
		os.MkdirAll(e.app.itemDir(id), 0o700)
		os.WriteFile(filepath.Join(e.app.itemDir(id), "seg000000"), []byte("x"), 0o600)
	}
	past := time.Now().Add(-time.Hour)
	os.Chtimes(e.app.itemDir(oldID), past, past)
	e.app.sweepOrphans()
	if _, err := os.Stat(e.app.itemDir(oldID)); !os.IsNotExist(err) {
		t.Fatal("old orphan directory not removed")
	}
	if _, err := os.Stat(e.app.itemDir(newID)); err != nil {
		t.Fatal("a recent directory (possibly an upload in progress) was removed")
	}
}

func TestCleanupAfterDeleteRacedWithWrite(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	id := randID() // no items row: the item was deleted while a write was in flight
	os.MkdirAll(e.app.itemDir(id), 0o700)
	os.WriteFile(filepath.Join(e.app.itemDir(id), "seg000000"), []byte("x"), 0o600)
	e.app.cleanupIfGone(id)
	if _, err := os.Stat(e.app.itemDir(id)); !os.IsNotExist(err) {
		t.Fatal("blob directory of a deleted item survived cleanup")
	}
}

func TestTrashedItemsCannotBeAddedToAlbums(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.readyItem(admin)
	alb := albumBody()
	admin.do("POST", "/api/albums", alb, true)
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{id}}, true)
	if code, _ := admin.do("PUT", "/api/albums/"+alb["id"].(string)+"/items", map[string]any{"item_ids": []string{id}}, true); code != 404 {
		t.Fatalf("trashed item added to album: %d", code)
	}
}

var _ = bytes.NewReader

func TestConcurrentAuxReplacementKeepsCounterConsistent(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.app.db.Exec(`UPDATE users SET quota_bytes=? WHERE email='bob@x.org'`, 100<<20)
	id := e.newItem(bob, 0)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			bob.put("/api/items/"+id+"/thumb", randBytes(1000+n*10))
		}(i)
	}
	wg.Wait()
	var stored, thumb int64
	e.app.db.QueryRow(`SELECT stored_bytes, thumb_bytes FROM items WHERE id=?`, id).Scan(&stored, &thumb)
	if stored != thumb || stored < 1000 {
		t.Fatalf("stored_bytes %d does not match thumb_bytes %d", stored, thumb)
	}
}

func TestFinishedItemsChargeTheirMetadata(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	id := e.newItem(bob, 0)
	bob.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(0))))
	// room for the file but not for its metadata: finalize is refused, the upload stays open
	e.app.db.Exec(`UPDATE users SET quota_bytes=? WHERE email='bob@x.org'`, cipherLen(0)+100)
	if code, _ := bob.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 413 {
		t.Fatalf("finalize over quota: %d", code)
	}
	e.app.db.Exec(`UPDATE users SET quota_bytes=? WHERE email='bob@x.org'`, 1<<20)
	if code, _ := bob.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	var stored int64
	e.app.db.QueryRow(`SELECT stored_bytes FROM items WHERE id=?`, id).Scan(&stored)
	if want := cipherLen(0) + finalizeCharge(); stored != want {
		t.Fatalf("stored_bytes %d, want %d", stored, want)
	}
}

// The search index and the people list live in app.db, but they are the account's data like its files: only the
// names and model families the apps use are taken, and their bytes count toward the storage limit.
func TestIndexAndUserBlobsCountTowardTheQuota(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	id := e.newItem(bob, 0)
	if code, _ := bob.do("PUT", "/api/me/blobs/other", map[string]any{"data_enc": rb(100), "version": 0}, true); code != 404 {
		t.Fatalf("unknown document name: %d", code)
	}
	if code, _ := bob.do("PUT", "/api/items/"+id+"/index", map[string]any{"data_enc": rb(100), "model": "f0/1"}, true); code != 400 {
		t.Fatalf("unknown model family: %d", code)
	}
	people, entry := rb(1000), rb(2000)
	if code, _ := bob.do("PUT", "/api/me/blobs/people", map[string]any{"data_enc": people, "version": 0}, true); code != 200 {
		t.Fatalf("people: %d", code)
	}
	if code, _ := bob.do("PUT", "/api/items/"+id+"/index", map[string]any{"data_enc": entry, "model": "mcs2/2"}, true); code != 200 {
		t.Fatalf("index: %d", code)
	}
	want := float64(len(people) + len(entry))
	if _, out := bob.do("GET", "/api/me/usage", nil, false); out["used_bytes"] != want {
		t.Fatalf("usage %v, want %v", out["used_bytes"], want)
	}
	_, out := admin.do("GET", "/api/admin/users", nil, false)
	for _, x := range out["users"].([]any) {
		if u := x.(map[string]any); u["email"] == "bob@x.org" && u["used_bytes"] != want {
			t.Fatalf("admin sees %v, want %v", u["used_bytes"], want)
		}
	}
	// a replacement costs only the difference; growing past the limit is refused
	e.app.db.Exec(`UPDATE users SET quota_bytes=? WHERE email='bob@x.org'`, int64(want)+10)
	if code, _ := bob.do("PUT", "/api/items/"+id+"/index", map[string]any{"data_enc": rb(1500), "model": "mcs2+yunet23+sface21/2"}, true); code != 200 {
		t.Fatalf("replacing an entry: %d", code)
	}
	if code, _ := bob.do("PUT", "/api/items/"+id+"/index", map[string]any{"data_enc": rb(1000), "model": "laionb32/1"}, true); code != 413 {
		t.Fatalf("index over quota: %d", code)
	}
	if code, _ := bob.do("PUT", "/api/me/blobs/people", map[string]any{"data_enc": rb(2000), "version": 1}, true); code != 413 {
		t.Fatalf("people over quota: %d", code)
	}
}
