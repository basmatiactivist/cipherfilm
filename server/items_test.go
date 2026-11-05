package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func (c *client) put(path string, body []byte) (int, map[string]any) {
	c.e.t.Helper()
	req, _ := http.NewRequest("PUT", c.e.srv.URL+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-CSRF-Token", c.csrf)
	resp, err := c.c.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

func (c *client) getRaw(path string) (int, []byte) {
	c.e.t.Helper()
	resp, err := c.c.Get(c.e.srv.URL + path)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func (e *env) newItem(c *client, size int64) string {
	e.t.Helper()
	code, out := c.do("POST", "/api/items", map[string]any{"kind": "image", "size": size, "segment_count": segCount(size)}, true)
	if code != 201 {
		e.t.Fatalf("create item: %d %v", code, out)
	}
	return out["id"].(string)
}

func finalizeBody() map[string]any {
	return map[string]any{"wrapped_item_key": rb(wrappedLen), "meta_enc": rb(80)}
}

// finalizeCharge is what finalizing with finalizeBody adds to the quota, for an item with files of these sizes.
func finalizeCharge(files ...int64) int64 {
	b := finalizeBody()
	n := int64(len(b["wrapped_item_key"].(string))+len(b["meta_enc"].(string))) + itemOverhead
	for _, f := range files {
		n += blockSlack(f)
	}
	return n
}

func TestUploadResumeAndFinalize(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	size := int64(segPlain + 10)
	id := e.newItem(admin, size)

	// segment 1 first, out of order
	seg1 := randBytes(int(cipherLen(10)))
	if code, _ := admin.put("/api/items/"+id+"/segments/1", seg1); code != 200 {
		t.Fatalf("seg1: %d", code)
	}
	// wrong length is rejected and nothing is stored for it
	if code, _ := admin.put("/api/items/"+id+"/segments/0", randBytes(1000)); code != 400 {
		t.Fatalf("short segment accepted: %d", code)
	}
	// finalize before everything arrived
	if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 409 {
		t.Fatalf("early finalize: %d", code)
	}
	// resume: server reports what it has
	_, st := admin.do("GET", "/api/items/"+id+"/upload", nil, false)
	if r := st["received"].([]any); len(r) != 1 || r[0].(float64) != 1 {
		t.Fatalf("received: %v", st["received"])
	}
	seg0 := randBytes(int(cipherLen(segPlain)))
	if code, _ := admin.put("/api/items/"+id+"/segments/0", seg0); code != 200 {
		t.Fatalf("seg0: %d", code)
	}
	// idempotent retry of the same segment
	if code, _ := admin.put("/api/items/"+id+"/segments/0", seg0); code != 200 {
		t.Fatalf("retry: %d", code)
	}
	if code, _ := admin.put("/api/items/"+id+"/thumb", randBytes(500)); code != 200 {
		t.Fatalf("thumb: %d", code)
	}
	if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	// stored bytes counted exactly once per segment (+thumb)
	var stored int64
	e.app.db.QueryRow(`SELECT stored_bytes FROM items WHERE id=?`, id).Scan(&stored)
	if want := int64(len(seg0)+len(seg1)+500) + finalizeCharge(int64(len(seg0)), int64(len(seg1)), 500); stored != want {
		t.Fatalf("stored_bytes %d want %d", stored, want)
	}
	// no more uploads after finalize
	if code, _ := admin.put("/api/items/"+id+"/segments/0", seg0); code != 400 {
		t.Fatalf("upload after finalize: %d", code)
	}
	code, got := admin.getRaw("/api/items/" + id + "/segments/0")
	if code != 200 || !bytes.Equal(got, seg0) {
		t.Fatalf("download: %d", code)
	}
	if code, got := admin.getRaw("/api/items/" + id + "/thumb"); code != 200 || len(got) != 500 {
		t.Fatalf("thumb download: %d", code)
	}
	_, list := admin.do("GET", "/api/items", nil, false)
	if items := list["items"].([]any); len(items) != 1 {
		t.Fatalf("list: %v", list)
	}
}

func TestItemsAreIsolatedBetweenUsers(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	id := e.newItem(admin, 10)
	admin.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true)

	for _, p := range []string{"/api/items/" + id + "/segments/0", "/api/items/" + id + "/thumb", "/api/items/" + id + "/preview", "/api/items/" + id + "/upload"} {
		if code, _ := bob.getRaw(p); code != 404 {
			t.Fatalf("GET %s as other user: %d", p, code)
		}
	}
	if code, _ := bob.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10)))); code != 404 {
		t.Fatalf("PUT as other user: %d", code)
	}
	if code, _ := bob.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 404 {
		t.Fatalf("finalize as other user: %d", code)
	}
	if code, _ := bob.do("DELETE", "/api/items/"+id, nil, true); code != 404 {
		t.Fatalf("delete as other user: %d", code)
	}
	if _, list := bob.do("GET", "/api/items", nil, false); len(list["items"].([]any)) != 0 {
		t.Fatal("bob sees admin's items")
	}
}

func TestItemInputValidation(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	for _, body := range []map[string]any{
		{"kind": "image", "size": -1, "segment_count": 1},
		{"kind": "image", "size": 10, "segment_count": 2},
		{"kind": "image", "size": int64(maxFileBytes) + 1, "segment_count": 2049},
		{"kind": "exe", "size": 10, "segment_count": 1},
	} {
		if code, _ := admin.do("POST", "/api/items", body, true); code != 400 {
			t.Fatalf("%v accepted: %d", body, code)
		}
	}
	// path traversal in the id never reaches the file system
	for _, id := range []string{"%2e%2e", "..%2F..%2Fetc", "ZZZ", "0123456789abcdef0123456789abcdeg"} {
		if code, _ := admin.getRaw("/api/items/" + id + "/thumb"); code != 404 && code != 400 {
			t.Fatalf("bad id %q: %d", id, code)
		}
	}
	id := e.newItem(admin, 10)
	if code, _ := admin.put("/api/items/"+id+"/segments/5", randBytes(int(cipherLen(10)))); code != 400 {
		t.Fatalf("segment index out of range: %d", code)
	}
	if code, _ := admin.put("/api/items/"+id+"/thumb", randBytes(maxThumbBytes+10)); code != 400 {
		t.Fatalf("oversized thumb: %d", code)
	}
	bad := finalizeBody()
	bad["wrapped_item_key"] = "short"
	if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", bad, true); code != 400 {
		t.Fatalf("bad finalize body: %d", code)
	}
}

func TestQuota(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.app.db.Exec(`UPDATE users SET quota_bytes=1000 WHERE email='bob@x.org'`)
	if code, _ := bob.do("POST", "/api/items", map[string]any{"kind": "image", "size": 5000, "segment_count": 1}, true); code != 413 {
		t.Fatalf("over-quota create: %d", code)
	}
	id := e.newItem(bob, 500) // ciphertext 541 fits
	if code, _ := bob.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(500)))); code != 200 {
		t.Fatalf("within quota: %d", code)
	}
	if code, _ := bob.do("POST", "/api/items", map[string]any{"kind": "image", "size": 500, "segment_count": 1}, true); code != 413 {
		t.Fatalf("second item should exceed quota: %d", code)
	}
	// the admin is unlimited
	e.newItem(admin, 5000)
}

func TestAbortStaleAndUserDeletionRemoveBlobs(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))

	// abort removes the blob directory
	id := e.newItem(bob, 10)
	bob.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	if _, err := os.Stat(e.app.itemDir(id)); err != nil {
		t.Fatal("blob dir missing")
	}
	if code, _ := bob.do("DELETE", "/api/items/"+id, nil, true); code != 200 {
		t.Fatalf("abort: %d", code)
	}
	if _, err := os.Stat(e.app.itemDir(id)); !os.IsNotExist(err) {
		t.Fatal("blob dir left behind after abort")
	}

	// stale uploads are swept
	stale := e.newItem(bob, 10)
	bob.put("/api/items/"+stale+"/segments/0", randBytes(int(cipherLen(10))))
	e.app.now = func() time.Time { return time.Now().Add(49 * time.Hour) }
	e.app.sweepStale()
	e.app.now = time.Now
	if _, err := os.Stat(e.app.itemDir(stale)); !os.IsNotExist(err) {
		t.Fatal("stale upload not swept")
	}

	// deleting a user deletes their files
	keep := e.newItem(bob, 10)
	bob.put("/api/items/"+keep+"/segments/0", randBytes(int(cipherLen(10))))
	bob.do("POST", "/api/items/"+keep+"/finalize", finalizeBody(), true)
	var bobID string
	e.app.db.QueryRow(`SELECT id FROM users WHERE email='bob@x.org'`).Scan(&bobID)
	if code, _ := admin.do("DELETE", "/api/admin/users/"+bobID, nil, true); code != 200 {
		t.Fatal("delete user")
	}
	if _, err := os.Stat(e.app.itemDir(keep)); !os.IsNotExist(err) {
		t.Fatal("deleted user's blobs left on disk")
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM items`).Scan(&n)
	if n != 0 {
		t.Fatalf("items rows left: %d", n)
	}
	_ = filepath.Join
}

func TestListsComeInPages(t *testing.T) {
	defer func(n int) { listPage = n }(listPage)
	listPage = 500
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	var uid string
	e.app.db.QueryRow(`SELECT id FROM users`).Scan(&uid)
	// more than two pages, with equal timestamps across page borders; every second item is in the trash
	e.app.db.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 2400)
		INSERT INTO items(id,user_id,kind,size_bytes,segment_count,created_at,state,wrapped_item_key,meta_enc,trashed_at)
		SELECT printf('%032x', i),?,'image',0,1,i/7,'ready','k','m',CASE WHEN i%2=0 THEN i/5 END FROM n`, uid)
	for _, path := range []string{"/api/items", "/api/trash"} {
		seen := map[string]bool{}
		pages, next := 0, ""
		for {
			p := path
			if next != "" {
				p += "?after=" + next
			}
			code, out := admin.do("GET", p, nil, false)
			if code != 200 {
				t.Fatalf("%s: %d", p, code)
			}
			items := out["items"].([]any)
			if len(items) > listPage {
				t.Fatalf("%s: page of %d", path, len(items))
			}
			for _, it := range items {
				id := it.(map[string]any)["id"].(string)
				if seen[id] {
					t.Fatalf("%s: %s twice", path, id)
				}
				seen[id] = true
			}
			pages++
			if next, _ = out["next"].(string); next == "" {
				break
			}
		}
		if len(seen) != 1200 || pages != 3 {
			t.Fatalf("%s: %d items in %d pages", path, len(seen), pages)
		}
	}
	if code, _ := admin.do("GET", "/api/items?after=nonsense", nil, false); code != 400 {
		t.Fatalf("bad cursor: %d", code)
	}
}

func TestFinalizeTakesAnItemKeySealedByTheBackup(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	for _, tc := range []struct {
		n    int
		want int
	}{{sealedItemKeyLen, 200}, {sealedItemKeyLen + 1, 400}, {60, 400}} {
		id := e.newItem(admin, 10)
		admin.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
		if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", map[string]any{"wrapped_item_key": rb(tc.n), "meta_enc": rb(80)}, true); code != tc.want {
			t.Errorf("key of %d bytes: %d, want %d", tc.n, code, tc.want)
		}
	}
}

// A page is bounded by the bytes of its encrypted fields too, not only by its number of rows; following next still
// returns everything. And only a few pages of one account are built at a time.
func TestListPagesAreBoundedInBytes(t *testing.T) {
	defer func(n int) { pageBytes = n }(pageBytes)
	pageBytes = 5000
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	var uid string
	e.app.db.QueryRow(`SELECT id FROM users`).Scan(&uid)
	e.app.db.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 30)
		INSERT INTO items(id,user_id,kind,size_bytes,segment_count,created_at,state,wrapped_item_key,meta_enc,trashed_at)
		SELECT printf('%032x', i),?,'image',0,1,i,'ready','k',printf('%01000d', 0),CASE WHEN i%2=0 THEN i END FROM n`, uid)
	e.app.db.Exec(`INSERT INTO item_index(item_id,user_id,model,data_enc,updated_at) SELECT id,user_id,'',meta_enc,created_at FROM items`)
	for path, want := range map[string]int{"/api/items": 15, "/api/trash": 15, "/api/index?since=0": 30} {
		seen, next := 0, ""
		for {
			p := path
			if next != "" {
				p = strings.Split(path, "?")[0] + "?after=" + next
			}
			code, out := admin.do("GET", p, nil, false)
			if code != 200 {
				t.Fatalf("%s: %d", p, code)
			}
			rows, _ := out["items"].([]any)
			if rows == nil {
				rows = out["entries"].([]any)
			}
			if len(rows) > 5 {
				t.Fatalf("%s: page of %d rows of 1000 bytes", path, len(rows))
			}
			seen += len(rows)
			if next, _ = out["next"].(string); next == "" {
				break
			}
		}
		if seen != want {
			t.Fatalf("%s: %d rows, want %d", path, seen, want)
		}
	}

	// with all of the account's turns taken, a page waits; a free turn lets it through
	turn := make(chan struct{}, listPerUser)
	for i := 0; i < listPerUser; i++ {
		turn <- struct{}{}
	}
	e.app.listMu.Lock()
	e.app.lists[uid] = turn
	e.app.listMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", e.srv.URL+"/api/items", nil)
	if resp, err := admin.c.Do(req); err == nil {
		resp.Body.Close()
		t.Fatalf("a page was sent while the account had no turn left: %d", resp.StatusCode)
	}
	<-turn
	if code, _ := admin.do("GET", "/api/items", nil, false); code != 200 {
		t.Fatalf("with a free turn: %d", code)
	}
}
