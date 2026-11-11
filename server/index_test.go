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
	if code, _ := bob.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(200), "model": "laionb32/1"}, true); code != 404 {
		t.Fatalf("foreign index: %d", code)
	}
	if code, _ := admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(maxIndexBytes + 1), "model": "laionb32/1"}, true); code != 400 {
		t.Fatalf("oversized index: %d", code)
	}
	if code, _ := admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": "!!", "model": "laionb32/1"}, true); code != 400 {
		t.Fatalf("not base64: %d", code)
	}
	for _, id := range []string{i1, i2, i1} { // the second write of i1 replaces the first
		if code, _ := admin.do("PUT", "/api/items/"+id+"/index", map[string]any{"data_enc": rb(300), "model": "laionb32/1"}, true); code != 200 {
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
	if len(list) != 5 || !seen["clip-b32-vision.onnx"] || !seen["clip-b32-text.onnx"] || !seen["clip-b32-tokenizer.json"] || !seen["sface-2021dec.onnx"] {
		t.Fatalf("%d models", len(list))
	}
	// MobileCLIP S2's license (apple-amlr) doesn't allow its use here: it is in no list, not even under an old name
	for _, m := range list {
		if strings.Contains(m.URL, "mobileclip") || strings.Contains(m.Name, "mobileclip") || strings.HasPrefix(m.Name, "nsfw-") {
			t.Fatalf("%+v", m)
		}
	}
}

// Apps before 2.1.4 ask the server for the models and follow no redirect: it passes them through, resumable. The
// files explicit search used to have under nsfw-* names are everyone's search model now, under those names too.
func TestModelsArePassedThroughForOlderApps(t *testing.T) {
	if !strings.Contains(modelURLs["clip-b32-text.onnx"], "/resolve/19a057a0fb927cf239541300e74237cd56c7ffe2/") {
		t.Fatal("pin")
	}
	fakeModelHost(t)
	e := newEnv(t)
	if code, _ := e.client().model("clip-b32-text.onnx"); code != 401 {
		t.Fatalf("model without a session: %d", code)
	}
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org")) // not allowed explicit search: gets the model all the same
	for _, c := range []*client{admin, bob} {
		if code, body := c.model("clip-b32-text.onnx"); code != 200 || body != "clip-b32-text.onnx bytes" {
			t.Fatalf("model: %d %q", code, body)
		}
		if code, body := c.model("clip-b32-text.onnx", "Range", "bytes=9-"); code != 206 || body != "text.onnx bytes" {
			t.Fatalf("resume: %d %q", code, body)
		}
		if code, body := c.model("nsfw-laion-b32-vision.onnx"); code != 200 || body != "clip-b32-vision.onnx bytes" {
			t.Fatalf("old name: %d %q", code, body)
		}
	}
	if code, _ := e.client().model("nsfw-laion-b32-vision.onnx"); code != 401 {
		t.Fatal("served without a session")
	}
	for _, p := range []string{"..%2Fsecret.txt", "nope.onnx", ".hidden", "Clip-b32-text.onnx", "mobileclip-s2-text.onnx", "mobileclip-s2-vision.onnx", "mobileclip-s2-tokenizer.json"} {
		if code, _ := admin.model(p); code != 404 {
			t.Fatalf("%s: %d", p, code)
		}
	}
}

// Explicit search (search results without the explicit-content filter) is off for everyone until an admin allows it
// for a person; the model is the same for everyone.
func TestExplicitSearchIsOffUntilTheAdminAllowsIt(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	nsfw := func(c *client) bool {
		_, me := c.do("GET", "/api/me", nil, false)
		return me["user"].(map[string]any)["nsfw"].(bool)
	}
	if nsfw(admin) || nsfw(bob) {
		t.Fatal("explicit search on by default")
	}
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
	// an admin may allow it for themselves, but still not change their own role through it
	if code, _ := admin.do("PATCH", "/api/admin/users/"+adminID, map[string]any{"nsfw": true}, true); code != 200 || !nsfw(admin) {
		t.Fatalf("admin for self: %d", code)
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+adminID, map[string]any{"nsfw": false, "role": "user"}, true); code != 400 {
		t.Fatal("admin changed own role")
	}
	admin.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"nsfw": false}, true)
	if nsfw(bob) {
		t.Fatal("still allowed")
	}
}

// An older app still on MobileCLIP (or from before 1.9.0, without a tag) may not write its entries: it is told to stop
// indexing ("not_indexer"), and if it was the indexing device it no longer is, so an updated device takes over.
func TestOldAppsCantWriteMobileCLIPEntries(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	phone := e.login("admin@x.org", ab)
	i1 := e.readyItem(admin)
	put := func(c *client, model string) (int, any) {
		body := map[string]any{"data_enc": rb(200)}
		if model != "-" {
			body["model"] = model
		}
		code, out := c.do("PUT", "/api/items/"+i1+"/index", body, true)
		return code, out["code"]
	}
	indexer := func() any { _, me := admin.do("GET", "/api/me", nil, false); return me["indexer"] }
	// no indexing device yet: an old app doesn't become it
	for _, m := range []string{"-", "", "mcs2/2", "mcs2+yunet23+sface21/2"} {
		if code, why := put(phone, m); code != 409 || why != "not_indexer" {
			t.Fatalf("old app wrote %q: %d %v", m, code, why)
		}
	}
	if indexer() != "" {
		t.Fatalf("an old app became the indexer: %v", indexer())
	}
	if code, _ := put(phone, "f0/1"); code != 400 {
		t.Fatalf("unknown family: %d", code)
	}
	// the phone was the indexer (it wrote LAION's entries before), then sends MobileCLIP's: it isn't any more
	if code, _ := put(phone, "laionb32/1"); code != 200 || indexer() == "" {
		t.Fatalf("new app: %d", code)
	}
	if code, why := put(phone, "mcs2/2"); code != 409 || why != "not_indexer" || indexer() != "" {
		t.Fatalf("old entry from the indexer: %d %v, indexer %v", code, why, indexer())
	}
	// the next device that writes the current model takes over
	if code, _ := put(admin, "laionb32+yunet23+sface21/1"); code != 200 {
		t.Fatalf("updated device: %d", code)
	}
	_, am := admin.do("GET", "/api/me", nil, false)
	if indexer() != am["session_id"] {
		t.Fatal("the updated device isn't the indexer")
	}
	if code, why := put(phone, "mcs2/2"); code != 409 || why != "not_indexer" || indexer() != am["session_id"] {
		t.Fatalf("an old app that isn't the indexer: %d %v", code, why)
	}
}

// The first page says how many entries a family has in all, so a device can tell that some were deleted since its
// last visit (an older app dropped some, or MobileCLIP's went) and fetch them all again.
func TestIndexListCountsTheFamily(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	_, me := admin.do("GET", "/api/me", nil, false)
	uid := me["user"].(map[string]any)["id"].(string)
	i1, i2, i3 := e.readyItem(admin), e.readyItem(admin), e.readyItem(admin)
	// left from an older app: MobileCLIP's for i2 and i3
	for _, id := range []string{i2, i3} {
		e.app.db.Exec(`INSERT INTO item_index(item_id,user_id,model,data_enc,updated_at) VALUES(?,?,'mcs2',?,1)`, id, uid, rb(200))
	}
	if code, _ := admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(200), "model": "laionb32+yunet23+sface21/1"}, true); code != 200 {
		t.Fatalf("index: %d", code)
	}
	count := func(q string) any { _, out := admin.do("GET", "/api/index"+q, nil, false); return out["count"] }
	if c := count("?model=mcs2"); c != float64(2) {
		t.Fatalf("mcs2: %v", c)
	}
	if c := count("?model=laionb32"); c != float64(1) {
		t.Fatalf("laionb32: %v", c)
	}
	if c := count(""); c != float64(3) {
		t.Fatalf("all: %v", c)
	}
	// counted whatever since says, so a device that has everything still learns about deletions
	if c := count("?model=mcs2&since=99999999999999"); c != float64(2) {
		t.Fatalf("since: %v", c)
	}
	admin.do("DELETE", "/api/index?model=mcs2", nil, true)
	if c := count("?model=mcs2"); c != float64(0) {
		t.Fatalf("after deleting: %v", c)
	}
	if c := count("?model=laionb32"); c != float64(1) {
		t.Fatalf("laionb32 after deleting mcs2: %v", c)
	}
	// not on later pages (after=): the first one is enough
	if c := count("?model=laionb32&after=1." + i1); c != nil {
		t.Fatalf("later page: %v", c)
	}
}
