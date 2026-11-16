package main

import (
	"io"
	"net/http"
	"path/filepath"
	"testing"
	"time"
)

// After a photo is turned or cropped, the apps replace its encrypted thumbnail and preview (docs/EDITING.md). Only a
// finished item of the owner's, not in the trash; the size rules of an upload; the difference is charged; the other
// devices see a change.
func TestReplaceThumbAndPreviewOfAFinishedItem(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	id := e.newItem(admin, 10)
	admin.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	admin.put("/api/items/"+id+"/thumb", randBytes(1000))

	// while uploading, the upload path is the one to use
	if code, _ := admin.put("/api/items/"+id+"/replace/thumb", randBytes(500)); code != 409 {
		t.Fatalf("replace before finalize: %d", code)
	}
	if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	// and the upload path stays closed after it
	if code, _ := admin.put("/api/items/"+id+"/thumb", randBytes(500)); code != 409 {
		t.Fatalf("upload path after finalize: %d", code)
	}
	var stored0, rev0 int64
	e.app.db.QueryRow(`SELECT stored_bytes, rev FROM items WHERE id=?`, id).Scan(&stored0, &rev0)

	for _, bad := range [][]byte{randBytes(10), randBytes(maxThumbBytes + 1)} {
		if code, _ := admin.put("/api/items/"+id+"/replace/thumb", bad); code != 400 {
			t.Fatalf("invalid thumbnail accepted: %d", code)
		}
	}
	if code, _ := bob.put("/api/items/"+id+"/replace/thumb", randBytes(500)); code != 404 {
		t.Fatalf("someone else's item: %d", code)
	}
	if code, _ := admin.put("/api/items/"+"00000000000000000000000000000000"+"/replace/thumb", randBytes(500)); code != 404 {
		t.Fatalf("unknown item: %d", code)
	}

	newThumb, newPreview := randBytes(5000), randBytes(70000)
	if code, _ := admin.put("/api/items/"+id+"/replace/thumb", newThumb); code != 200 {
		t.Fatalf("replace thumb: %d", code)
	}
	if code, _ := admin.put("/api/items/"+id+"/replace/preview", newPreview); code != 200 {
		t.Fatalf("replace preview (none before): %d", code)
	}
	if code, got := admin.getRaw("/api/items/" + id + "/thumb"); code != 200 || string(got) != string(newThumb) {
		t.Fatalf("thumb not replaced: %d", code)
	}
	if code, got := admin.getRaw("/api/items/" + id + "/preview"); code != 200 || string(got) != string(newPreview) {
		t.Fatalf("preview not replaced: %d", code)
	}
	var stored, rev, th, pv int64
	var hasPreview bool
	e.app.db.QueryRow(`SELECT stored_bytes, rev, thumb_bytes, preview_bytes, has_preview FROM items WHERE id=?`, id).Scan(&stored, &rev, &th, &pv, &hasPreview)
	want := stored0 + (5000 + blockSlack(5000) - 1000 - blockSlack(1000)) + (70000 + blockSlack(70000))
	if stored != want || th != 5000 || pv != 70000 || !hasPreview {
		t.Fatalf("stored_bytes %d (want %d), thumb %d, preview %d, has_preview %v", stored, want, th, pv, hasPreview)
	}
	if rev <= rev0 {
		t.Fatalf("rev %d not after %d: the other devices would not notice", rev, rev0)
	}
	// a smaller one gives the room back
	if code, _ := admin.put("/api/items/"+id+"/replace/thumb", randBytes(1000)); code != 200 {
		t.Fatal("replace again")
	}
	e.app.db.QueryRow(`SELECT stored_bytes FROM items WHERE id=?`, id).Scan(&stored)
	if want := stored0 + 70000 + blockSlack(70000); stored != want {
		t.Fatalf("stored_bytes %d want %d", stored, want)
	}

	// in the trash: nothing to edit
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{id}}, true)
	if code, _ := admin.put("/api/items/"+id+"/replace/thumb", randBytes(500)); code != 409 {
		t.Fatalf("replace in the trash: %d", code)
	}
}

func TestReplacePreviewRespectsTheQuota(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	id := e.readyItem(bob)
	e.app.db.Exec(`UPDATE users SET quota_bytes=(SELECT stored_bytes FROM items WHERE id=?)+1000 WHERE email='bob@x.org'`, id)
	if code, _ := bob.put("/api/items/"+id+"/replace/preview", randBytes(500)); code != 413 {
		t.Fatalf("over the quota: %d", code)
	}
	var pv int64
	e.app.db.QueryRow(`SELECT preview_bytes FROM items WHERE id=?`, id).Scan(&pv)
	if pv != 0 {
		t.Fatal("a refused preview was counted")
	}
}

func TestDemoCannotReplacePictures(t *testing.T) {
	_, _, demo, _, item := demoEnv(t)
	for _, p := range []string{"/replace/thumb", "/replace/preview"} {
		if code, _ := demo.put("/api/items/"+item+p, randBytes(500)); code != 403 {
			t.Fatalf("demo %s: %d", p, code)
		}
	}
}

// Replacing a thumbnail and preview that were already there (has_thumb and has_preview stay 1), even with one of the
// same size, must still reach the other devices: the item comes back in the change list, or they keep the old pictures.
func TestReplacingExistingPicturesShowsInTheChangeList(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.newItem(admin, 10)
	admin.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	admin.put("/api/items/"+id+"/thumb", randBytes(1000))
	admin.put("/api/items/"+id+"/preview", randBytes(5000))
	if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	for _, p := range []struct {
		path string
		size int
	}{{"thumb", 1000}, {"preview", 5000}, {"thumb", 1200}, {"preview", 4000}} {
		var rev0 int64
		e.app.db.QueryRow(`SELECT rev FROM items WHERE id=?`, id).Scan(&rev0)
		cur := admin.cursorOf("/api/items")
		if code, _ := admin.put("/api/items/"+id+"/replace/"+p.path, randBytes(p.size)); code != 200 {
			t.Fatalf("replace %s: %d", p.path, code)
		}
		var rev int64
		e.app.db.QueryRow(`SELECT rev FROM items WHERE id=?`, id).Scan(&rev)
		if rev <= rev0 {
			t.Fatalf("replace %s (%d bytes): rev %d not after %d", p.path, p.size, rev, rev0)
		}
		if got := admin.since("/api/items", cur); !same(got.items, id) {
			t.Fatalf("replace %s (%d bytes): change list %v", p.path, p.size, got.items)
		}
	}
}

// A person at their storage limit can still replace a thumbnail or preview with one that takes no more room; a larger
// one is refused, and nothing is counted for it.
func TestReplacingAtTheLimitNeedsOnlyTheDifference(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	id := e.newItem(bob, 10)
	bob.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	bob.put("/api/items/"+id+"/thumb", randBytes(3000))
	bob.put("/api/items/"+id+"/preview", randBytes(50000))
	if code, _ := bob.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	e.app.db.Exec(`UPDATE users SET quota_bytes=(SELECT stored_bytes FROM items WHERE id=?) WHERE email='bob@x.org'`, id)
	stored := func() (n int64) {
		e.app.db.QueryRow(`SELECT stored_bytes FROM items WHERE id=?`, id).Scan(&n)
		return
	}
	full := stored()
	for _, p := range []struct {
		path string
		size int
		want int
	}{{"preview", 50000, 200}, {"preview", 40000, 200}, {"thumb", 3000, 200}, {"thumb", 2000, 200}, {"thumb", 3000, 200}, {"thumb", 20000, 413}} {
		if code, _ := bob.put("/api/items/"+id+"/replace/"+p.path, randBytes(p.size)); code != p.want {
			t.Fatalf("replace %s with %d bytes at the limit: %d, want %d", p.path, p.size, code, p.want)
		}
	}
	if want := full - (50000 + blockSlack(50000)) + 40000 + blockSlack(40000); stored() != want {
		t.Fatalf("stored_bytes %d, want %d", stored(), want)
	}
}

// Items finished before thumb_bytes and preview_bytes were counted have 0 there, though their files are on disk and
// in stored_bytes: a replacement credits the old file's size, not nothing.
func TestReplacingAPictureFromBeforeItWasCountedCreditsTheOldOne(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.newItem(admin, 10)
	admin.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	admin.put("/api/items/"+id+"/thumb", randBytes(5000))
	if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	e.app.db.Exec(`UPDATE items SET thumb_bytes=0 WHERE id=?`, id) // as an older server left it
	var stored0 int64
	e.app.db.QueryRow(`SELECT stored_bytes FROM items WHERE id=?`, id).Scan(&stored0)
	if code, _ := admin.put("/api/items/"+id+"/replace/thumb", randBytes(5000)); code != 200 {
		t.Fatalf("replace: %d", code)
	}
	var stored, th int64
	e.app.db.QueryRow(`SELECT stored_bytes, thumb_bytes FROM items WHERE id=?`, id).Scan(&stored, &th)
	if stored != stored0 || th != 5000 {
		t.Fatalf("stored_bytes %d (was %d), thumb_bytes %d", stored, stored0, th)
	}
}

// At the storage limit nothing of a replacement reaches the disk before it is known to fit: a larger picture is
// refused without a staged file, and one that takes no more room is still taken.
func TestReplacingAtTheLimitStagesNothingOnDiskFirst(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	id := e.newItem(bob, 10)
	bob.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	bob.put("/api/items/"+id+"/preview", randBytes(50000))
	if code, _ := bob.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	e.app.db.Exec(`UPDATE users SET quota_bytes=(SELECT stored_bytes FROM items WHERE id=?) WHERE email='bob@x.org'`, id)
	staged := func() int {
		m, _ := filepath.Glob(filepath.Join(e.app.itemDir(id), ".tmp-*"))
		return len(m)
	}
	for _, p := range []struct{ size, want int }{{maxPreviewBytes, 413}, {40000, 200}} {
		seen := -1
		code := bob.putDuring("/api/items/"+id+"/replace/preview", randBytes(p.size), func() { seen = staged() })
		if code != p.want {
			t.Fatalf("replace with %d bytes at the limit: %d, want %d", p.size, code, p.want)
		}
		if seen != 0 {
			t.Fatalf("replace with %d bytes at the limit: %d staged file(s) while the body was read", p.size, seen)
		}
		if staged() != 0 {
			t.Fatal("staged file left behind")
		}
	}
}

// holdPut starts a PUT whose body is sent only in part (first) and then held until the returned writer gets the rest
// or is closed; done gets the status (0 if the request failed).
func (c *client) holdPut(path string, first []byte, total int64) (*io.PipeWriter, chan int) {
	c.e.t.Helper()
	pr, pw := io.Pipe()
	c.e.t.Cleanup(func() { pw.CloseWithError(io.ErrUnexpectedEOF) }) // before the test server closes
	req, _ := http.NewRequest("PUT", c.e.srv.URL+path, pr)
	req.ContentLength = total
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-CSRF-Token", c.csrf)
	done := make(chan int, 1)
	go func() {
		resp, err := c.c.Do(req)
		if err != nil {
			done <- 0
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	go pw.Write(first)
	return pw, done
}

// A replacement's whole body is reserved while it is staged next to the picture it replaces, so held replacements
// never put more on the disk than the account has room for. Past that room, one replacement at a time per account is
// read into memory (and may be taken if it fits the old picture's place); others wait for it and are turned away.
func TestHeldReplacementsAreReservedOrOneAtATime(t *testing.T) {
	defer func(w time.Duration) { atLimitWait = w }(atLimitWait)
	atLimitWait = 300 * time.Millisecond
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	uid := e.userID("bob@x.org")
	id := e.newItem(bob, 10)
	bob.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	bob.put("/api/items/"+id+"/preview", randBytes(maxPreviewBytes))
	if code, _ := bob.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	staged := func() int {
		m, _ := filepath.Glob(filepath.Join(e.app.itemDir(id), ".tmp-*"))
		return len(m)
	}
	path := "/api/items/" + id + "/replace/preview"
	full := int64(maxPreviewBytes + blockSlack(maxPreviewBytes))

	// room for two whole bodies: two are staged, each reserved in full; a third is read into memory, a fourth waits
	// for it and is turned away
	e.app.db.Exec(`UPDATE users SET quota_bytes=used_bytes+? WHERE id=?`, 2*full, uid)
	var held []*io.PipeWriter
	var dones []chan int
	for i := 0; i < 2; i++ {
		pw, done := bob.holdPut(path, randBytes(1000), 40000)
		held, dones = append(held, pw), append(dones, done)
	}
	time.Sleep(500 * time.Millisecond)
	if n, room := staged(), e.app.roomLeft(uid); n != 2 || room != 0 {
		t.Fatalf("two held with room for both: %d staged, %d room left", n, room)
	}
	pw3, done3 := bob.holdPut(path, randBytes(1000), 40000)
	time.Sleep(200 * time.Millisecond)
	_, done4 := bob.holdPut(path, randBytes(1000), 40000)
	select {
	case code := <-done4:
		if code != 429 {
			t.Fatalf("a second replacement without room: %d, want 429", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a second replacement without room was held")
	}
	if n := staged(); n != 2 {
		t.Fatalf("the replacement without room was staged before it was read: %d staged", n)
	}
	// the one in memory fits the old picture's place and is taken; the staged ones finish too
	go pw3.Write(randBytes(39000))
	if code := <-done3; code != 200 {
		t.Fatalf("the replacement read into memory: %d", code)
	}
	for i, pw := range held {
		go pw.Write(randBytes(39000))
		if code := <-dones[i]; code != 200 {
			t.Fatalf("staged replacement %d: %d", i, code)
		}
	}

	// a completely full account with a picture of the largest size: nothing is reserved, so nothing is staged while
	// the body is read, and only one replacement at a time
	e.app.db.Exec(`UPDATE users SET quota_bytes=used_bytes WHERE id=?`, uid)
	bob.put(path, randBytes(maxPreviewBytes)) // back to the largest size, which fits its own place
	var hold []*io.PipeWriter
	var codes []chan int
	for i := 0; i < 4; i++ {
		pw, done := bob.holdPut(path, randBytes(1000), maxPreviewBytes)
		hold, codes = append(hold, pw), append(codes, done)
	}
	time.Sleep(time.Second)
	if n := staged(); n != 0 {
		t.Fatalf("held replacements at a full quota staged %d file(s)", n)
	}
	refused := 0
	for _, c := range codes {
		select {
		case code := <-c:
			if code != 429 {
				t.Fatalf("held replacement at a full quota: %d", code)
			}
			refused++
		default:
		}
	}
	if refused != 3 {
		t.Fatalf("%d of 4 held replacements turned away, want 3", refused)
	}
	for _, pw := range hold {
		pw.CloseWithError(io.ErrUnexpectedEOF)
	}
	time.Sleep(200 * time.Millisecond)
	if n := staged(); n != 0 {
		t.Fatalf("%d staged file(s) left", n)
	}
	if code, _ := bob.put(path, randBytes(40000)); code != 200 {
		t.Fatalf("a replacement after the held ones ended: %d", code)
	}
}
