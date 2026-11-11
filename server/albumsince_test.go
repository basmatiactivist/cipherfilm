package main

import (
	"net/url"
	"testing"
	"time"
)

type albumSince struct {
	albums  map[string][]string // id -> item ids
	order   []string
	removed []string
	cursor  string
	reset   bool
}

func (c *client) albumsSince(cursor string) albumSince {
	c.e.t.Helper()
	code, out := c.do("GET", "/api/albums?since="+url.QueryEscape(cursor), nil, false)
	if code != 200 {
		c.e.t.Fatalf("albums since: %d %v", code, out)
	}
	r := albumSince{albums: map[string][]string{}, cursor: out["cursor"].(string), reset: out["reset"] == true}
	if out["more"] != false {
		c.e.t.Fatalf("more: %v", out["more"])
	}
	for _, x := range out["albums"].([]any) {
		m := x.(map[string]any)
		ids := []string{}
		for _, i := range m["item_ids"].([]any) {
			ids = append(ids, i.(string))
		}
		if m["name_enc"].(string) == "" || m["created_at"] == nil {
			c.e.t.Fatalf("album without its fields: %v", m)
		}
		r.albums[m["id"].(string)] = ids
		r.order = append(r.order, m["id"].(string))
	}
	for _, x := range out["removed"].([]any) {
		r.removed = append(r.removed, x.(string))
	}
	return r
}

// wholeAlbums: every album as the whole list sends it, id -> item ids.
func (c *client) wholeAlbums() map[string][]string {
	c.e.t.Helper()
	_, out := c.do("GET", "/api/albums", nil, false)
	r := map[string][]string{}
	for _, x := range out["albums"].([]any) {
		m := x.(map[string]any)
		ids := []string{}
		for _, i := range m["item_ids"].([]any) {
			ids = append(ids, i.(string))
		}
		r[m["id"].(string)] = ids
	}
	return r
}

func TestAlbumsSinceSendsOnlyChangedAlbums(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	i1, i2 := e.readyItem(admin), e.readyItem(admin)
	a1, a2, a3 := albumBody(), albumBody(), albumBody()
	for _, a := range []map[string]any{a1, a2, a3} {
		admin.do("POST", "/api/albums", a, true)
	}
	id1, id2, id3 := a1["id"].(string), a2["id"].(string), a3["id"].(string)
	admin.do("PUT", "/api/albums/"+id1+"/items", map[string]any{"item_ids": []string{i1}}, true)
	cur := admin.cursorOf("/api/albums")

	// nothing changed: nothing sent
	r := admin.albumsSince(cur)
	if r.reset || len(r.albums) != 0 || len(r.removed) != 0 || r.cursor != cur {
		t.Fatalf("no change: %+v", r)
	}
	// a photo added to one album: only that album, whole
	admin.do("PUT", "/api/albums/"+id2+"/items", map[string]any{"item_ids": []string{i1, i2}}, true)
	r = admin.albumsSince(cur)
	if len(r.albums) != 1 || !same(r.albums[id2], i1, i2) || len(r.removed) != 0 {
		t.Fatalf("add: %+v", r)
	}
	cur = r.cursor
	// renamed: that album
	admin.do("PATCH", "/api/albums/"+id3, map[string]any{"name_enc": rb(70)}, true)
	r = admin.albumsSince(cur)
	if len(r.albums) != 1 || r.albums[id3] == nil {
		t.Fatalf("rename: %+v", r)
	}
	cur = r.cursor
	// a photo taken out
	admin.do("DELETE", "/api/albums/"+id2+"/items/"+i2, nil, true)
	r = admin.albumsSince(cur)
	if len(r.albums) != 1 || !same(r.albums[id2], i1) {
		t.Fatalf("remove item: %+v", r)
	}
	cur = r.cursor
	// a photo in two albums trashed: both, without it; restored: both, with it again
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i1}}, true)
	r = admin.albumsSince(cur)
	if len(r.albums) != 2 || !same(r.albums[id1]) || !same(r.albums[id2]) {
		t.Fatalf("trash: %+v", r)
	}
	cur = r.cursor
	admin.do("POST", "/api/items/restore", map[string]any{"item_ids": []string{i1}}, true)
	r = admin.albumsSince(cur)
	if len(r.albums) != 2 || !same(r.albums[id1], i1) || !same(r.albums[id2], i1) {
		t.Fatalf("restore: %+v", r)
	}
	cur = r.cursor
	// a photo in no album trashed: no album changes
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i2}}, true)
	if r = admin.albumsSince(cur); len(r.albums) != 0 {
		t.Fatalf("a photo in no album: %+v", r)
	}
	// purged from the trash: the albums it was in
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i1}}, true)
	cur = admin.albumsSince(cur).cursor
	admin.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{i1}}, true)
	r = admin.albumsSince(cur)
	if !same(r.order, id1, id2) || len(r.albums[id1]) != 0 {
		t.Fatalf("purge: %+v", r)
	}
	cur = r.cursor
	// deleted: its id as removed, not as an album
	admin.do("DELETE", "/api/albums/"+id3, nil, true)
	r = admin.albumsSince(cur)
	if len(r.albums) != 0 || !same(r.removed, id3) {
		t.Fatalf("delete: %+v", r)
	}
	// created and changed since an old cursor: each once; created and deleted: removed only
	a4, a5 := albumBody(), albumBody()
	admin.do("POST", "/api/albums", a4, true)
	admin.do("POST", "/api/albums", a5, true)
	admin.do("PATCH", "/api/albums/"+a4["id"].(string), map[string]any{"name_enc": rb(70)}, true)
	admin.do("DELETE", "/api/albums/"+a5["id"].(string), nil, true)
	r = admin.albumsSince(cur)
	if !same(r.order, a4["id"].(string)) || !same(r.removed, id3, a5["id"].(string)) {
		t.Fatalf("since an old cursor: %+v", r)
	}
}

// Applying the changes to the list as it was gives the whole list as it is now, whatever happened in between.
func TestAlbumsSinceMatchesWholeList(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	items := []string{e.readyItem(admin), e.readyItem(admin), e.readyItem(admin)}
	ids := []string{}
	for range 3 {
		a := albumBody()
		admin.do("POST", "/api/albums", a, true)
		ids = append(ids, a["id"].(string))
	}
	have := admin.wholeAlbums()
	cur := admin.cursorOf("/api/albums")
	steps := []func(){
		func() { admin.do("PUT", "/api/albums/"+ids[0]+"/items", map[string]any{"item_ids": items}, true) },
		func() { admin.do("PUT", "/api/albums/"+ids[1]+"/items", map[string]any{"item_ids": items[1:]}, true) },
		func() { admin.do("POST", "/api/items/trash", map[string]any{"item_ids": items[1:2]}, true) },
		func() { admin.do("DELETE", "/api/albums/"+ids[2], nil, true) },
		func() { admin.do("DELETE", "/api/albums/"+ids[0]+"/items/"+items[0], nil, true) },
		func() { admin.do("POST", "/api/items/restore", map[string]any{"item_ids": items[1:2]}, true) },
	}
	for n, step := range steps {
		step()
		r := admin.albumsSince(cur)
		if r.reset {
			t.Fatalf("step %d: reset", n)
		}
		for _, id := range r.removed {
			delete(have, id)
		}
		for id, its := range r.albums {
			have[id] = its
		}
		cur = r.cursor
		want := admin.wholeAlbums()
		if len(want) != len(have) {
			t.Fatalf("step %d: %v, want %v", n, have, want)
		}
		for id, its := range want {
			if !same(have[id], its...) {
				t.Fatalf("step %d: album %s has %v, want %v", n, id, have[id], its)
			}
		}
	}
}

func TestAlbumsSinceIsPerAccountAndResets(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	cur := bob.cursorOf("/api/albums")
	admin.do("POST", "/api/albums", albumBody(), true)
	if r := bob.albumsSince(cur); len(r.albums)+len(r.removed) != 0 || r.reset {
		t.Fatalf("another account's album: %+v", r)
	}
	// another epoch, ahead of the account, malformed
	for _, bad := range []string{"0000000000000000.0", cur[:17] + "999"} {
		if r := bob.albumsSince(bad); !r.reset || r.cursor != cur {
			t.Fatalf("%s must reset: %+v", bad, r)
		}
	}
	if code, _ := bob.do("GET", "/api/albums?since=x", nil, false); code != 400 {
		t.Fatalf("malformed: %d", code)
	}

	// tombstones older than the retention go; a cursor from before them resets
	a := albumBody()
	bob.do("POST", "/api/albums", a, true)
	old := bob.cursorOf("/api/albums")
	bob.do("DELETE", "/api/albums/"+a["id"].(string), nil, true)
	e.app.now = func() time.Time { return time.Now().Add(29 * 24 * time.Hour) }
	e.app.pruneAlbumTombstones()
	if r := bob.albumsSince(old); r.reset || !same(r.removed, a["id"].(string)) {
		t.Fatalf("before the retention: %+v", r)
	}
	e.app.now = func() time.Time { return time.Now().Add(31 * 24 * time.Hour) }
	e.app.pruneAlbumTombstones()
	if r := bob.albumsSince(old); !r.reset {
		t.Fatalf("an old cursor must reset: %+v", r)
	}
	if r := bob.albumsSince(bob.cursorOf("/api/albums")); r.reset {
		t.Fatalf("a new cursor: %+v", r)
	}
}
