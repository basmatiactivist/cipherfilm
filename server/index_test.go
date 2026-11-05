package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestFavoritesAreOwnAndShowInTheList(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	i1, i2 := e.readyItem(admin), e.readyItem(admin)
	if code, _ := bob.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{i1}, "favorite": true}, true); code != 404 {
		t.Fatalf("foreign favorite: %d", code)
	}
	if code, _ := admin.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{i1}, "favorite": true}, true); code != 200 {
		t.Fatalf("favorite: %d", code)
	}
	fav := func() map[string]bool {
		_, out := admin.do("GET", "/api/items", nil, false)
		m := map[string]bool{}
		for _, x := range out["items"].([]any) {
			it := x.(map[string]any)
			m[it["id"].(string)] = it["favorite"].(bool)
		}
		return m
	}
	if f := fav(); !f[i1] || f[i2] {
		t.Fatalf("after marking: %v", f)
	}
	admin.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{i1}, "favorite": false}, true)
	if f := fav(); f[i1] {
		t.Fatal("still a favorite")
	}
	if code, _ := admin.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{}, "favorite": true}, true); code != 400 {
		t.Fatalf("empty list: %d", code)
	}
}

func TestIndexEntriesAreOwnBoundedAndPaged(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	i1, i2 := e.readyItem(admin), e.readyItem(admin)
	if code, _ := bob.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(200)}, true); code != 404 {
		t.Fatalf("foreign index: %d", code)
	}
	if code, _ := admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(maxIndexBytes + 1)}, true); code != 400 {
		t.Fatalf("oversized index: %d", code)
	}
	if code, _ := admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": "!!"}, true); code != 400 {
		t.Fatalf("not base64: %d", code)
	}
	for _, id := range []string{i1, i2, i1} { // the second write of i1 replaces the first
		if code, _ := admin.do("PUT", "/api/items/"+id+"/index", map[string]any{"data_enc": rb(300)}, true); code != 200 {
			t.Fatalf("index: %d", code)
		}
	}
	_, out := admin.do("GET", "/api/index", nil, false)
	if n := len(out["entries"].([]any)); n != 2 {
		t.Fatalf("entries: %d", n)
	}
	if _, theirs := bob.do("GET", "/api/index", nil, false); len(theirs["entries"].([]any)) != 0 {
		t.Fatal("bob sees admin's index")
	}
	// since=now gives nothing older
	now := int64(out["now"].(float64))
	if _, later := admin.do("GET", "/api/index?since="+strconv.FormatInt(now+1, 10), nil, false); len(later["entries"].([]any)) != 0 {
		t.Fatal("since filter")
	}
	if code, _ := admin.do("GET", "/api/index?after=x", nil, false); code != 400 {
		t.Fatalf("bad cursor: %d", code)
	}
	// purging an item removes its index entry with it
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i2}}, true)
	admin.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{i2}}, true)
	if _, out = admin.do("GET", "/api/index", nil, false); len(out["entries"].([]any)) != 1 {
		t.Fatal("purged item's index stayed")
	}
	admin.do("DELETE", "/api/index", nil, true)
	if _, out = admin.do("GET", "/api/index", nil, false); len(out["entries"].([]any)) != 0 {
		t.Fatal("clear")
	}
}

func TestUserBlobsKeepVersions(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	if code, _ := admin.do("GET", "/api/me/blobs/people", nil, false); code != 404 {
		t.Fatalf("missing blob: %d", code)
	}
	if code, out := admin.do("PUT", "/api/me/blobs/people", map[string]any{"data_enc": rb(100), "version": 0}, true); code != 200 || out["version"].(float64) != 1 {
		t.Fatalf("create: %d %v", code, out)
	}
	if code, _ := admin.do("PUT", "/api/me/blobs/people", map[string]any{"data_enc": rb(100), "version": 0}, true); code != 409 {
		t.Fatalf("second create: %d", code)
	}
	if code, _ := admin.do("PUT", "/api/me/blobs/people", map[string]any{"data_enc": rb(100), "version": 1}, true); code != 200 {
		t.Fatalf("update: %d", code)
	}
	if code, _ := admin.do("PUT", "/api/me/blobs/people", map[string]any{"data_enc": rb(100), "version": 1}, true); code != 409 {
		t.Fatalf("stale update: %d", code)
	}
	if code, out := admin.do("GET", "/api/me/blobs/people", nil, false); code != 200 || out["version"].(float64) != 2 {
		t.Fatalf("get: %d %v", code, out)
	}
	if code, _ := bob.do("GET", "/api/me/blobs/people", nil, false); code != 404 {
		t.Fatal("bob reads admin's people")
	}
	if code, _ := admin.do("GET", "/api/me/blobs/Bad", nil, false); code != 404 {
		t.Fatal("bad name")
	}
	admin.do("DELETE", "/api/index", nil, true)
	if code, _ := admin.do("GET", "/api/me/blobs/people", nil, false); code != 404 {
		t.Fatal("clearing the index keeps the people list")
	}
}

func TestModelsAreServedOnlyFromTheirFolder(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "clip-text.onnx"), []byte("model"), 0o600)
	os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.txt"), []byte("no"), 0o600)
	e.app.modelsDir = dir
	c := e.client()
	if code, b := c.getRaw("/api/models/clip-text.onnx"); code != 200 || string(b) != "model" {
		t.Fatalf("model: %d %q", code, b)
	}
	for _, p := range []string{"/api/models/..%2Fsecret.txt", "/api/models/nope.onnx", "/api/models/.hidden"} {
		if code, b := c.getRaw(p); code == 200 || strings.Contains(string(b), "no\n") {
			t.Fatalf("%s: %d", p, code)
		}
	}
	e.app.modelsDir = ""
	if code, _ := c.getRaw("/api/models/clip-text.onnx"); code != 404 {
		t.Fatal("served without MODELS_DIR")
	}
}

func TestExplicitSearchIsOffUntilTheAdminAllowsIt(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "nsfw-clip.onnx"), []byte("model"), 0o600)
	e.app.modelsDir = dir
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	nsfw := func(c *client) bool {
		_, me := c.do("GET", "/api/me", nil, false)
		return me["user"].(map[string]any)["nsfw"].(bool)
	}
	// off for everyone at first, admins included, and the model is not served
	if nsfw(admin) || nsfw(bob) {
		t.Fatal("explicit search on by default")
	}
	for _, c := range []*client{e.client(), bob, admin} {
		if code, _ := c.getRaw("/api/models/nsfw-clip.onnx"); code != 404 {
			t.Fatalf("explicit model served without permission: %d", code)
		}
	}
	// only an admin can allow it
	_, list := admin.do("GET", "/api/admin/users", nil, false)
	var bobID, adminID string
	for _, u := range list["users"].([]any) {
		m := u.(map[string]any)
		if m["nsfw"] != false {
			t.Fatal("admin list: nsfw not false")
		}
		if m["email"] == "bob@x.org" {
			bobID = m["id"].(string)
		} else {
			adminID = m["id"].(string)
		}
	}
	if code, _ := bob.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"nsfw": true}, true); code != 404 && code != 403 {
		t.Fatalf("a user allowed themselves: %d", code)
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"nsfw": true}, true); code != 200 {
		t.Fatalf("allow: %d", code)
	}
	if !nsfw(bob) || nsfw(admin) {
		t.Fatal("allowed for the wrong person")
	}
	if code, b := bob.getRaw("/api/models/nsfw-clip.onnx"); code != 200 || string(b) != "model" {
		t.Fatalf("allowed person doesn't get the model: %d", code)
	}
	if code, _ := e.client().getRaw("/api/models/nsfw-clip.onnx"); code != 404 {
		t.Fatal("served without a session")
	}
	// an admin may allow it for themselves, but still not change their own role through it
	if code, _ := admin.do("PATCH", "/api/admin/users/"+adminID, map[string]any{"nsfw": true}, true); code != 200 || !nsfw(admin) {
		t.Fatalf("admin for self: %d", code)
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+adminID, map[string]any{"nsfw": false, "role": "user"}, true); code != 400 {
		t.Fatal("admin changed own role")
	}
	// turned off again: the model is gone for them
	admin.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"nsfw": false}, true)
	if nsfw(bob) {
		t.Fatal("still allowed")
	}
	if code, _ := bob.getRaw("/api/models/nsfw-clip.onnx"); code != 404 {
		t.Fatal("model served after turning it off")
	}
}

func TestOldAppsCantOverwriteEntriesWhereExplicitSearchIsAllowed(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	i1 := e.readyItem(admin)
	if code, _ := admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(200)}, true); code != 200 {
		t.Fatalf("old app, not allowed: %d", code)
	}
	_, me := admin.do("GET", "/api/me", nil, false)
	id := me["user"].(map[string]any)["id"].(string)
	admin.do("PATCH", "/api/admin/users/"+id, map[string]any{"nsfw": true}, true)
	if code, _ := admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(200)}, true); code != 409 {
		t.Fatalf("old app wrote where explicit search is allowed: %d", code)
	}
	if code, _ := admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(200), "model": "laionb32+yunet23+sface21/1"}, true); code != 200 {
		t.Fatalf("new app: %d", code)
	}
}
