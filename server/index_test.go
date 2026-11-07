package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
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

// model asks for a search model: the status and what came back. fakeModelHost stands in for Hugging Face, so the tests
// stay off the network.
func (c *client) model(name string, header ...string) (int, string) {
	c.e.t.Helper()
	req, _ := http.NewRequest("GET", c.e.srv.URL+"/api/models/"+name, nil)
	if len(header) == 2 {
		req.Header.Set(header[0], header[1])
	}
	resp, err := c.c.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// fakeModelHost serves every pinned model as "<name> bytes" (with Range) from a test server, via a redirect like
// Hugging Face's to its CDN.
func fakeModelHost(t *testing.T) {
	t.Helper()
	host := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/resolve/") {
			http.Redirect(w, r, "/cdn/"+strings.TrimPrefix(r.URL.Path, "/resolve/"), http.StatusFound)
			return
		}
		http.ServeContent(w, r, "", time.Time{}, strings.NewReader(strings.TrimPrefix(r.URL.Path, "/cdn/")+" bytes"))
	}))
	t.Cleanup(host.Close)
	saved, savedClient := modelURLs, modelClient
	modelURLs = map[string]string{}
	for name := range saved {
		modelURLs[name] = host.URL + "/resolve/" + name
	}
	c := host.Client()
	c.CheckRedirect = modelClient.CheckRedirect
	modelClient = c
	t.Cleanup(func() { modelURLs, modelClient = saved, savedClient })
}

// The list every app uses: well-formed, the pins the docs name, nothing twice.
func TestModelListIsPinned(t *testing.T) {
	var list []struct {
		Name, URL, SHA256 string
		Size              int64
	}
	if err := json.Unmarshal(modelsJSON, &list); err != nil {
		t.Fatal(err)
	}
	pinned := regexp.MustCompile(`^https://huggingface\.co/[\w.-]+/[\w.-]+/resolve/[0-9a-f]{40}/[\w./-]+$`)
	seen := map[string]bool{}
	for _, m := range list {
		if seen[m.Name] || !pinned.MatchString(m.URL) || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(m.SHA256) || m.Size <= 0 {
			t.Fatalf("%+v", m)
		}
		seen[m.Name] = true
	}
	if len(list) != 7 || !seen["mobileclip-s2-text.onnx"] || !seen["nsfw-laion-b32-text.onnx"] || !seen["sface-2021dec.onnx"] {
		t.Fatalf("%d models", len(list))
	}
}

// Apps before 2.1.4 ask the server for the models and follow no redirect: it passes them through, resumable.
func TestModelsArePassedThroughForOlderApps(t *testing.T) {
	if !strings.Contains(modelURLs["mobileclip-s2-text.onnx"], "/resolve/0c311c620b36a2270b851db7bef9135f3eaae5d7/") {
		t.Fatal("pin")
	}
	fakeModelHost(t)
	e := newEnv(t)
	if code, _ := e.client().model("mobileclip-s2-text.onnx"); code != 401 {
		t.Fatalf("model without a session: %d", code)
	}
	c, _ := e.setupAdmin("admin@x.org")
	if code, body := c.model("mobileclip-s2-text.onnx"); code != 200 || body != "mobileclip-s2-text.onnx bytes" {
		t.Fatalf("model: %d %q", code, body)
	}
	if code, body := c.model("mobileclip-s2-text.onnx", "Range", "bytes=11-"); code != 206 || body != "s2-text.onnx bytes" {
		t.Fatalf("resume: %d %q", code, body)
	}
	for _, p := range []string{"..%2Fsecret.txt", "nope.onnx", ".hidden", "Mobileclip-s2-text.onnx"} {
		if code, _ := c.model(p); code != 404 {
			t.Fatalf("%s: %d", p, code)
		}
	}
}

func TestExplicitSearchIsOffUntilTheAdminAllowsIt(t *testing.T) {
	fakeModelHost(t)
	e := newEnv(t)
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
	if code, _ := e.client().model("nsfw-laion-b32-text.onnx"); code != 401 {
		t.Fatalf("explicit model served without a session: %d", code)
	}
	for _, c := range []*client{bob, admin} {
		if code, _ := c.model("nsfw-laion-b32-text.onnx"); code != 404 {
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
	if code, body := bob.model("nsfw-laion-b32-vision.onnx"); code != 200 || body != "nsfw-laion-b32-vision.onnx bytes" {
		t.Fatalf("allowed person doesn't get the model: %d %q", code, body)
	}
	if code, _ := e.client().model("nsfw-laion-b32-vision.onnx"); code != 401 {
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
	if code, _ := bob.model("nsfw-laion-b32-vision.onnx"); code != 404 {
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
