package main

import (
	"os"
	"testing"
	"time"
)

func TestTrashRestorePurge(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	i1, i2, i3 := e.readyItem(admin), e.readyItem(admin), e.readyItem(admin)
	alb := albumBody()
	admin.do("POST", "/api/albums", alb, true)
	admin.do("PUT", "/api/albums/"+alb["id"].(string)+"/items", map[string]any{"item_ids": []string{i1, i2}}, true)

	count := func(path string) int {
		_, out := admin.do("GET", path, nil, false)
		return len(out["items"].([]any))
	}
	// others cannot trash, restore or purge someone else's items
	if code, _ := bob.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i1}}, true); code != 404 {
		t.Fatalf("foreign trash: %d", code)
	}
	if code, _ := admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i1, i2}}, true); code != 200 {
		t.Fatalf("trash: %d", code)
	}
	if code, _ := admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i1}}, true); code != 404 {
		t.Fatalf("double trash: %d", code)
	}
	if count("/api/items") != 1 || count("/api/trash") != 2 {
		t.Fatal("lists after trashing")
	}
	// trashed items leave albums' visible contents, but stay in the album
	_, al := admin.do("GET", "/api/albums", nil, false)
	if n := len(al["albums"].([]any)[0].(map[string]any)["item_ids"].([]any)); n != 0 {
		t.Fatalf("trashed items still shown in album: %d", n)
	}
	// thumbs and segments stay readable (the trash view needs them); others still get 404
	if code, _ := admin.getRaw("/api/items/" + i1 + "/segments/0"); code != 200 {
		t.Fatal("trashed item unreadable")
	}
	if code, _ := bob.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{i1}}, true); code != 200 {
		t.Fatal("bob purge call")
	}
	if count("/api/trash") != 2 {
		t.Fatal("bob purged admin's trash")
	}
	// restore one: back in the library and back in its album
	if code, _ := admin.do("POST", "/api/items/restore", map[string]any{"item_ids": []string{i1}}, true); code != 200 {
		t.Fatal("restore")
	}
	_, al = admin.do("GET", "/api/albums", nil, false)
	if n := len(al["albums"].([]any)[0].(map[string]any)["item_ids"].([]any)); n != 1 {
		t.Fatalf("restored item not back in its album: %d", n)
	}
	// not-in-trash items cannot be purged
	if code, out := admin.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{i3}}, true); code != 200 || out["removed"].(float64) != 0 {
		t.Fatalf("purge of a live item: %d %v", code, out)
	}
	// purge removes rows, blobs and frees quota
	if code, out := admin.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{i2}}, true); code != 200 || out["removed"].(float64) != 1 {
		t.Fatalf("empty trash: %d %v", code, out)
	}
	if _, err := os.Stat(e.app.itemDir(i2)); !os.IsNotExist(err) {
		t.Fatal("blobs of purged item left on disk")
	}
	if count("/api/trash") != 0 || count("/api/items") != 2 {
		t.Fatal("final lists")
	}
}

func TestTrashExpiresAfterThirtyDays(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	old, fresh := e.readyItem(admin), e.readyItem(admin)
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{old}}, true)
	e.app.now = func() time.Time { return time.Now().Add(-31 * 24 * time.Hour) }
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{fresh}}, true)
	e.app.now = func() time.Time { return time.Now().Add(0) }
	// make `old` 31 days old and `fresh` recent
	e.app.db.Exec(`UPDATE items SET trashed_at=? WHERE id=?`, time.Now().Add(-31*24*time.Hour).Unix(), old)
	e.app.db.Exec(`UPDATE items SET trashed_at=? WHERE id=?`, time.Now().Add(-29*24*time.Hour).Unix(), fresh)
	e.app.now = time.Now
	e.app.purgeExpiredTrash()
	if _, err := os.Stat(e.app.itemDir(old)); !os.IsNotExist(err) {
		t.Fatal("expired item's blobs not purged")
	}
	if _, err := os.Stat(e.app.itemDir(fresh)); err != nil {
		t.Fatal("item inside the retention window was purged")
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM items`).Scan(&n)
	if n != 1 {
		t.Fatalf("rows: %d", n)
	}
}

func TestAdminQuotaAndUsage(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.readyItem(bob)
	_, list := admin.do("GET", "/api/admin/users", nil, false)
	var bobID string
	for _, u := range list["users"].([]any) {
		m := u.(map[string]any)
		if m["email"] == "bob@x.org" {
			bobID = m["id"].(string)
			if m["item_count"].(float64) != 1 || m["used_bytes"].(float64) <= 0 || m["quota_bytes"].(float64) != defaultUserQuota {
				t.Fatalf("usage: %v", m)
			}
		}
	}
	for _, body := range []map[string]any{{}, {"quota_bytes": -1}, {"status": "bogus"}} {
		if code, _ := admin.do("PATCH", "/api/admin/users/"+bobID, body, true); code != 400 {
			t.Fatalf("%v: %d", body, code)
		}
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"quota_bytes": 100}, true); code != 200 {
		t.Fatal("set quota")
	}
	if code, _ := bob.do("POST", "/api/items", map[string]any{"kind": "image", "size": 500, "segment_count": 1}, true); code != 413 {
		t.Fatalf("new quota not enforced: %d", code)
	}
	if code, _ := bob.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"quota_bytes": 0}, true); code != 404 {
		t.Fatalf("user changed own quota: %d", code)
	}
}
