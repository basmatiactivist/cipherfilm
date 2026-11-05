package main

import "testing"

func (e *env) readyItem(c *client) string {
	id := e.newItem(c, 10)
	c.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	if code, _ := c.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		e.t.Fatalf("finalize %d", code)
	}
	return id
}

func albumBody() map[string]any { return map[string]any{"id": randID(), "name_enc": rb(60)} }

func TestAlbumLifecycle(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	i1, i2 := e.readyItem(admin), e.readyItem(admin)

	a1, a2 := albumBody(), albumBody()
	for _, a := range []map[string]any{a1, a2} {
		if code, _ := admin.do("POST", "/api/albums", a, true); code != 201 {
			t.Fatalf("create: %d", code)
		}
	}
	if code, _ := admin.do("POST", "/api/albums", a1, true); code != 409 {
		t.Fatalf("duplicate id: %d", code)
	}
	// one item can be in several albums; adding twice is harmless
	for _, aid := range []any{a1["id"], a2["id"]} {
		if code, _ := admin.do("PUT", "/api/albums/"+aid.(string)+"/items", map[string]any{"item_ids": []string{i1}}, true); code != 200 {
			t.Fatalf("add: %d", code)
		}
	}
	admin.do("PUT", "/api/albums/"+a1["id"].(string)+"/items", map[string]any{"item_ids": []string{i1, i2}}, true)

	_, list := admin.do("GET", "/api/albums", nil, false)
	albums := list["albums"].([]any)
	if len(albums) != 2 {
		t.Fatalf("albums: %v", albums)
	}
	count := map[string]int{}
	for _, x := range albums {
		m := x.(map[string]any)
		count[m["id"].(string)] = len(m["item_ids"].([]any))
	}
	if count[a1["id"].(string)] != 2 || count[a2["id"].(string)] != 1 {
		t.Fatalf("membership: %v", count)
	}

	// rename keeps membership
	newName := rb(70)
	if code, _ := admin.do("PATCH", "/api/albums/"+a1["id"].(string), map[string]any{"name_enc": newName}, true); code != 200 {
		t.Fatal("rename")
	}
	// remove from album
	if code, _ := admin.do("DELETE", "/api/albums/"+a1["id"].(string)+"/items/"+i2, nil, true); code != 200 {
		t.Fatal("remove item")
	}
	// deleting an album keeps its items
	if code, _ := admin.do("DELETE", "/api/albums/"+a2["id"].(string), nil, true); code != 200 {
		t.Fatal("delete album")
	}
	_, items := admin.do("GET", "/api/items", nil, false)
	if len(items["items"].([]any)) != 2 {
		t.Fatal("items were deleted with the album")
	}
	_, list = admin.do("GET", "/api/albums", nil, false)
	if albums = list["albums"].([]any); len(albums) != 1 || len(albums[0].(map[string]any)["item_ids"].([]any)) != 1 {
		t.Fatalf("after changes: %v", albums)
	}
}

func TestAlbumsAreIsolatedAndValidated(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	ai := e.readyItem(admin)
	a := albumBody()
	admin.do("POST", "/api/albums", a, true)
	aid := a["id"].(string)

	if _, list := bob.do("GET", "/api/albums", nil, false); len(list["albums"].([]any)) != 0 {
		t.Fatal("bob sees admin's albums")
	}
	if code, _ := bob.do("PATCH", "/api/albums/"+aid, map[string]any{"name_enc": rb(60)}, true); code != 404 {
		t.Fatalf("rename foreign album: %d", code)
	}
	if code, _ := bob.do("DELETE", "/api/albums/"+aid, nil, true); code != 404 {
		t.Fatalf("delete foreign album: %d", code)
	}
	if code, _ := bob.do("PUT", "/api/albums/"+aid+"/items", map[string]any{"item_ids": []string{ai}}, true); code != 404 {
		t.Fatalf("add to foreign album: %d", code)
	}
	// bob cannot put admin's item into his own album, and cannot probe for its existence
	b := albumBody()
	bob.do("POST", "/api/albums", b, true)
	if code, _ := bob.do("PUT", "/api/albums/"+b["id"].(string)+"/items", map[string]any{"item_ids": []string{ai}}, true); code != 404 {
		t.Fatalf("add foreign item: %d", code)
	}
	// validation
	if code, _ := admin.do("POST", "/api/albums", map[string]any{"id": "nope", "name_enc": rb(60)}, true); code != 400 {
		t.Fatalf("bad id: %d", code)
	}
	if code, _ := admin.do("POST", "/api/albums", map[string]any{"id": randID(), "name_enc": "x"}, true); code != 400 {
		t.Fatalf("bad name: %d", code)
	}
	// an unfinished upload cannot be added
	pending := e.newItem(admin, 10)
	if code, _ := admin.do("PUT", "/api/albums/"+aid+"/items", map[string]any{"item_ids": []string{pending}}, true); code != 404 {
		t.Fatalf("add unfinished item: %d", code)
	}
}

func TestRecoveryKeyRotation(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	c := e.client()
	nk := bundle() // supplies correctly sized random fields
	body := func(cur any) map[string]any {
		return map[string]any{"current_auth": cur, "wrapped_master_recovery": nk["wrapped_master_recovery"], "recovery_verifier": nk["recovery_verifier"]}
	}
	if code, _ := admin.do("POST", "/api/auth/recovery-key", body(rb(32)), true); code != 403 {
		t.Fatalf("wrong password accepted: %d", code)
	}
	if code, _ := admin.do("POST", "/api/auth/recovery-key", map[string]any{"current_auth": ab["auth"], "wrapped_master_recovery": "x", "recovery_verifier": "y"}, true); code != 400 {
		t.Fatalf("bad fields: %d", code)
	}
	if code, _ := c.do("POST", "/api/auth/recovery-key", body(ab["auth"]), false); code != 401 {
		t.Fatalf("signed-out rotation: %d", code)
	}
	if code, out := admin.do("POST", "/api/auth/recovery-key", body(ab["auth"]), true); code != 200 {
		t.Fatalf("rotate: %d %v", code, out)
	}
	// the old recovery key is dead, the new one works, and the password still works
	if code, _ := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": ab["recovery_verifier"].(string)}, false); code != 401 {
		t.Fatalf("old recovery key still valid: %d", code)
	}
	if code, out := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": nk["recovery_verifier"].(string)}, false); code != 200 || out["wrapped_master_recovery"] != nk["wrapped_master_recovery"] {
		t.Fatalf("new recovery key: %d", code)
	}
	if code, _ := e.client().do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": ab["auth"].(string)}, false); code != 200 {
		t.Fatal("password stopped working")
	}
}

func TestUsageEndpoint(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.readyItem(bob)
	_, out := bob.do("GET", "/api/me/usage", nil, false)
	if out["used_bytes"].(float64) <= 0 || out["quota_bytes"].(float64) != defaultUserQuota || out["unlimited"] != false {
		t.Fatalf("usage: %v", out)
	}
	if _, out = admin.do("GET", "/api/me/usage", nil, false); out["unlimited"] != true {
		t.Fatalf("admin usage: %v", out)
	}
}

func TestAlbumEntriesAreBounded(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	al := albumBody()
	admin.do("POST", "/api/albums", al, true)
	id := e.readyItem(admin)
	var uid string
	e.app.db.QueryRow(`SELECT id FROM users`).Scan(&uid)
	// fill the account up to the limit with entries in a second album
	e.app.db.Exec(`INSERT INTO albums(id,user_id,name_enc,created_at) VALUES ('ffffffffffffffffffffffffffffffff',?,'x',0)`, uid)
	e.app.db.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
		INSERT INTO items(id,user_id,kind,size_bytes,segment_count,created_at,state) SELECT printf('%032x', i),?,'image',0,1,0,'ready' FROM n`, maxAlbumEntries, uid)
	e.app.db.Exec(`INSERT INTO album_items(album_id,item_id,added_at) SELECT 'ffffffffffffffffffffffffffffffff', id, 0 FROM items WHERE id LIKE '0000%'`)
	if code, _ := admin.do("PUT", "/api/albums/"+al["id"].(string)+"/items", map[string]any{"item_ids": []string{id}}, true); code != 400 {
		t.Fatalf("entry past the limit: %d", code)
	}
	// album count is checked in the insert
	e.app.db.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
		INSERT INTO albums(id,user_id,name_enc,created_at) SELECT printf('a%031x', i),?,'x',0 FROM n`, maxAlbumsPerUser, uid)
	if code, _ := admin.do("POST", "/api/albums", albumBody(), true); code != 400 {
		t.Fatalf("album past the limit: %d", code)
	}
}
