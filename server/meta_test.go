package main

import "testing"

func TestPutMetaReplacesTheEncryptedMetadata(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	id := e.newItem(admin, 10)
	admin.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))

	newMeta := rb(120)
	// not finished yet: nothing to update
	if code, _ := admin.do("PUT", "/api/items/"+id+"/meta", map[string]any{"meta_enc": newMeta}, true); code != 409 {
		t.Fatalf("meta before finalize: %d", code)
	}
	if code, _ := admin.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	var stored0, rev0 int64
	e.app.db.QueryRow(`SELECT stored_bytes, rev FROM items WHERE id=?`, id).Scan(&stored0, &rev0)

	for _, bad := range []any{"", "not base64!", rb(10), rb(maxMetaBytes + 1)} {
		if code, _ := admin.do("PUT", "/api/items/"+id+"/meta", map[string]any{"meta_enc": bad}, true); code != 400 {
			t.Fatalf("invalid meta accepted: %d", code)
		}
	}
	if code, _ := bob.do("PUT", "/api/items/"+id+"/meta", map[string]any{"meta_enc": newMeta}, true); code != 404 {
		t.Fatalf("other user: %d", code)
	}
	if code, _ := admin.do("PUT", "/api/items/"+id+"/meta", map[string]any{"meta_enc": newMeta}, true); code != 200 {
		t.Fatalf("update: %d", code)
	}
	var meta string
	var stored, rev int64
	e.app.db.QueryRow(`SELECT meta_enc, stored_bytes, rev FROM items WHERE id=?`, id).Scan(&meta, &stored, &rev)
	if meta != newMeta {
		t.Fatal("meta not replaced")
	}
	// the size difference counts toward the storage limit, and the other devices see a change
	if want := stored0 + int64(len(newMeta)-len(finalizeBody()["meta_enc"].(string))); stored != want {
		t.Fatalf("stored_bytes %d want %d", stored, want)
	}
	if rev <= rev0 {
		t.Fatalf("rev %d not after %d", rev, rev0)
	}
	_, list := admin.do("GET", "/api/items", nil, false)
	if got := list["items"].([]any)[0].(map[string]any)["meta_enc"]; got != newMeta {
		t.Fatalf("list shows %v", got)
	}
}
