package main

import "testing"

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
