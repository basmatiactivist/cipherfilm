package main

import (
	"testing"
	"time"
)

func storageNum(m map[string]any, keys ...string) int64 {
	var v any = m
	for _, k := range keys {
		v = v.(map[string]any)[k]
	}
	return int64(v.(float64))
}

func storageAccount(t *testing.T, out map[string]any, email string) map[string]any {
	t.Helper()
	for _, x := range out["accounts"].([]any) {
		if a := x.(map[string]any); a["email"] == email {
			return a
		}
	}
	t.Fatalf("%s not in the overview", email)
	return nil
}

func TestStorageOverviewNumbersAndAccess(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.acceptInvite(e.invite(admin, "carol@x.org"))

	// bob: a photo with a thumbnail and a preview, and a video without
	id := e.newItem(bob, 1000)
	bob.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(1000))))
	bob.put("/api/items/"+id+"/thumb", randBytes(500))
	bob.put("/api/items/"+id+"/preview", randBytes(700))
	if code, _ := bob.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize photo: %d", code)
	}
	code, out := bob.do("POST", "/api/items", map[string]any{"kind": "video", "size": 2000, "segment_count": segCount(2000)}, true)
	if code != 201 {
		t.Fatalf("create video: %d", code)
	}
	vid := out["id"].(string)
	bob.put("/api/items/"+vid+"/segments/0", randBytes(int(cipherLen(2000))))
	if code, _ := bob.do("POST", "/api/items/"+vid+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize video: %d", code)
	}

	code, mine := bob.do("GET", "/api/me/storage", nil, false)
	if code != 200 {
		t.Fatalf("me/storage: %d", code)
	}
	_, usage := bob.do("GET", "/api/me/usage", nil, false)
	used := storageNum(mine, "used_bytes")
	if used != storageNum(usage, "used_bytes") || used != e.app.usedBytes(userIDOf(e, "bob@x.org")) {
		t.Fatalf("used %d differs from the limit's counter %v", used, usage["used_bytes"])
	}
	if n := storageNum(mine, "item_count"); n != 2 {
		t.Fatalf("item_count %d, want 2", n)
	}
	photos, videos, thumbs := storageNum(mine, "split", "photos"), storageNum(mine, "split", "videos"), storageNum(mine, "split", "thumbs")
	if thumbs != 1200+blockSlack(500)+blockSlack(700) {
		t.Fatalf("thumbnails and previews: %d, want 1200 and their blocks", thumbs)
	}
	if photos < cipherLen(1000) || videos < cipherLen(2000) {
		t.Fatalf("photos %d videos %d", photos, videos)
	}
	sum := photos + videos + thumbs + storageNum(mine, "split", "other") + storageNum(mine, "split", "index")
	if sum != used {
		t.Fatalf("split adds up to %d, used is %d", sum, used)
	}
	devs := mine["devices"].([]any)
	if len(devs) != 1 {
		t.Fatalf("devices: %v", devs)
	}
	d := devs[0].(map[string]any)
	if d["current"] != true || d["last_upload_at"].(float64) == 0 || d["backup_stale"] != false {
		t.Fatalf("this device: %v", d)
	}

	// someone who isn't an admin can't see the others: the admin route looks absent
	if code, _ := bob.do("GET", "/api/admin/storage", nil, false); code != 404 {
		t.Fatalf("non-admin got the overview: %d", code)
	}
	if code, _ := e.client().do("GET", "/api/me/storage", nil, false); code != 401 {
		t.Fatalf("signed out: %d", code)
	}

	code, all := admin.do("GET", "/api/admin/storage", nil, false)
	if code != 200 {
		t.Fatalf("admin/storage: %d", code)
	}
	if n := len(all["accounts"].([]any)); n != 3 {
		t.Fatalf("accounts: %d", n)
	}
	b := storageAccount(t, all, "bob@x.org")
	if storageNum(b, "used_bytes") != used || storageNum(b, "split", "thumbs") != thumbs || storageNum(b, "item_count") != 2 {
		t.Fatalf("bob in the admin overview: %v", b)
	}
	if bd := b["devices"].([]any); len(bd) != 1 || bd[0].(map[string]any)["current"] == true {
		t.Fatalf("bob's devices to the admin: %v", bd)
	}
	var total int64
	for _, x := range all["accounts"].([]any) {
		total += storageNum(x.(map[string]any), "used_bytes")
	}
	if storageNum(all, "used_bytes") != total || storageNum(all, "item_count") != 2 || all["disk_total_bytes"].(float64) <= 0 {
		t.Fatalf("totals: %v", all)
	}
	// nothing about content: no names, dates or places in what an account reports
	for _, k := range []string{"meta_enc", "name_enc", "wrapped_item_key"} {
		if _, ok := b[k]; ok {
			t.Fatalf("%s in the overview", k)
		}
	}
}

func userIDOf(e *env, email string) string {
	u, err := e.app.userByEmail(email)
	if err != nil {
		e.t.Fatal(err)
	}
	return u.ID
}

func TestBackupStaleOnlyForAPhoneStillInUse(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.readyItem(bob)
	id := userIDOf(e, "bob@x.org")
	now := time.Now().Unix()
	set := func(device string, upload, seen int64) map[string]any {
		t.Helper()
		e.app.db.Exec(`UPDATE sessions SET device=?, last_upload_at=?, last_seen=? WHERE user_id=?`, device, upload, seen, id)
		_, all := admin.do("GET", "/api/admin/storage", nil, false)
		return storageAccount(t, all, "bob@x.org")["devices"].([]any)[0].(map[string]any)
	}
	day := int64(24 * 3600)
	if d := set("Pixel 8 (Android app)", now-8*day, now-3600); d["backup_stale"] != true || d["auto_backup"] != true {
		t.Fatalf("a phone used today that last uploaded 8 days ago: %v", d)
	}
	if d := set("Pixel 8 (Android app)", now-3*day, now-3600); d["backup_stale"] != false {
		t.Fatalf("uploaded 3 days ago: %v", d)
	}
	if d := set("Pixel 8 (Android app)", now-30*day, now-10*day); d["backup_stale"] != false {
		t.Fatalf("a phone not used for 10 days is not a stopped backup: %v", d)
	}
	if d := set("Pixel 8 (Android app)", 0, now-3600); d["backup_stale"] != false {
		t.Fatalf("no upload recorded: %v", d)
	}
	if d := set("Firefox on Linux", now-30*day, now-3600); d["backup_stale"] != false || d["auto_backup"] != false {
		t.Fatalf("a browser uploads by hand: %v", d)
	}
	_, all := admin.do("GET", "/api/admin/storage", nil, false)
	if storageNum(all, "stale_devices") != 0 {
		t.Fatalf("stale_devices: %v", all["stale_devices"])
	}
}

func TestStorageOverviewKeepsTheDemoAccountsDevicesPrivate(t *testing.T) {
	t.Setenv("DEMO_ACCOUNTS", "demo@x.org")
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	_, db := e.acceptInvite(e.invite(admin, "demo@x.org"))
	one := e.login("demo@x.org", db)
	two := e.login("demo@x.org", db)
	// two strangers on the shared demo login each see only their own device
	for _, c := range []*client{one, two} {
		code, out := c.do("GET", "/api/me/storage", nil, false)
		if code != 200 {
			t.Fatalf("demo me/storage: %d", code)
		}
		if d := out["devices"].([]any); len(d) != 1 || d[0].(map[string]any)["current"] != true {
			t.Fatalf("demo sees other devices: %v", d)
		}
		// and never anyone else's account
		if code, _ := c.do("GET", "/api/admin/storage", nil, false); code != 404 {
			t.Fatalf("demo got the admin overview: %d", code)
		}
	}
	// the admin sees the demo account's storage, not the strangers' devices
	_, all := admin.do("GET", "/api/admin/storage", nil, false)
	d := storageAccount(t, all, "demo@x.org")
	if d["devices_hidden"] != true || len(d["devices"].([]any)) != 0 {
		t.Fatalf("demo devices shown to the admin: %v", d)
	}
}

// Of another person's devices an admin sees on which day each was last used, not the time; the person's own overview,
// and the admin's own row, keep the exact time. The stale-backup hint still comes from the exact time.
func TestAdminSeesOnlyTheDayOtherDevicesWereUsed(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.readyItem(bob)
	id := userIDOf(e, "bob@x.org")
	day := int64(24 * 3600)
	seen := time.Now().Unix() - 3600
	if seen%day == 0 {
		seen-- // a time that is not itself a midnight
	}
	e.app.db.Exec(`UPDATE sessions SET device='Pixel 8 (Android app)', last_upload_at=?, last_seen=? WHERE user_id=?`, seen-8*day, seen, id)

	_, all := admin.do("GET", "/api/admin/storage", nil, false)
	d := storageAccount(t, all, "bob@x.org")["devices"].([]any)[0].(map[string]any)
	if got := storageNum(d, "last_seen"); got != seen-seen%day || d["last_seen_day_only"] != true {
		t.Fatalf("bob's device to the admin: last_seen %d (want %d), %v", got, seen-seen%day, d)
	}
	if d["backup_stale"] != true || storageNum(d, "last_upload_at") != seen-8*day {
		t.Fatalf("the stale hint and the last upload stay: %v", d)
	}
	mine := storageAccount(t, all, "admin@x.org")["devices"].([]any)[0].(map[string]any)
	if _, ok := mine["last_seen_day_only"]; ok || storageNum(mine, "last_seen")%day == 0 && storageNum(mine, "last_seen") != 0 {
		t.Fatalf("the admin's own device: %v", mine)
	}

	_, own := bob.do("GET", "/api/me/storage", nil, false)
	od := own["devices"].([]any)[0].(map[string]any)
	if _, ok := od["last_seen_day_only"]; ok || storageNum(od, "last_seen") < seen {
		t.Fatalf("bob's own overview keeps the exact time: %v", od)
	}
}
