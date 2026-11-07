package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"
)

type sinceResp struct {
	items   []string // ids, in the order sent
	removed []string
	cursor  string
	more    bool
	reset   bool
	raw     map[string]any
}

func (c *client) since(path, cursor string) sinceResp {
	c.e.t.Helper()
	code, out := c.do("GET", path+"?since="+url.QueryEscape(cursor), nil, false)
	if code != 200 {
		c.e.t.Fatalf("since %s: %d %v", path, code, out)
	}
	r := sinceResp{raw: out, cursor: out["cursor"].(string), more: out["more"] == true, reset: out["reset"] == true}
	for _, x := range out["items"].([]any) {
		r.items = append(r.items, x.(map[string]any)["id"].(string))
	}
	for _, x := range out["removed"].([]any) {
		r.removed = append(r.removed, x.(string))
	}
	return r
}

// cursorOf: the cursor a whole list hands out with its first page.
func (c *client) cursorOf(path string) string {
	c.e.t.Helper()
	_, out := c.do("GET", path, nil, false)
	cur, _ := out["cursor"].(string)
	if !cursorRe.MatchString(cur) {
		c.e.t.Fatalf("%s: no cursor in %v", path, out)
	}
	return cur
}

func same(got []string, want ...string) bool {
	if len(got) != len(want) {
		return false
	}
	g, w := append([]string{}, got...), append([]string{}, want...)
	sort.Strings(g)
	sort.Strings(w)
	return strings.Join(g, ",") == strings.Join(w, ",")
}

func TestSinceSendsChangesAndRemovals(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	i1, i2 := e.readyItem(admin), e.readyItem(admin)
	cur, tcur := admin.cursorOf("/api/items"), admin.cursorOf("/api/trash")

	// nothing changed: nothing comes, the cursor stays
	if r := admin.since("/api/items", cur); len(r.items)+len(r.removed) != 0 || r.cursor != cur || r.more || r.reset {
		t.Fatalf("idle: %+v", r)
	}
	if r := admin.since("/api/items", cur); r.raw["quota_left"] == nil || r.raw["unlimited"] == nil {
		t.Fatal("since leaves out the quota the whole list sends")
	}
	if r := admin.since("/api/trash", tcur); r.raw["retention_days"] == nil {
		t.Fatal("since leaves out the trash's retention")
	}
	// an unfinished upload is in no list
	pending := e.newItem(admin, 10)
	if r := admin.since("/api/items", cur); len(r.items) != 0 {
		t.Fatalf("an unfinished upload was sent: %v", r.items)
	}
	// finalized: in, with the whole record
	admin.put("/api/items/"+pending+"/segments/0", randBytes(int(cipherLen(10))))
	admin.do("POST", "/api/items/"+pending+"/finalize", finalizeBody(), true)
	r := admin.since("/api/items", cur)
	if !same(r.items, pending) || len(r.removed) != 0 || r.cursor == cur {
		t.Fatalf("finalize: %+v", r)
	}
	rec := r.raw["items"].([]any)[0].(map[string]any)
	for _, k := range []string{"kind", "size", "segment_count", "wrapped_item_key", "meta_enc", "has_thumb", "has_preview", "created_at", "favorite"} {
		if _, ok := rec[k]; !ok {
			t.Fatalf("record without %s: %v", k, rec)
		}
	}
	cur = r.cursor

	// favorite: the record again; the same value again is no change
	admin.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{i1}, "favorite": true}, true)
	r = admin.since("/api/items", cur)
	if !same(r.items, i1) || r.raw["items"].([]any)[0].(map[string]any)["favorite"] != true {
		t.Fatalf("favorite: %+v", r)
	}
	cur = r.cursor
	admin.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{i1}, "favorite": true}, true)
	if r = admin.since("/api/items", cur); len(r.items) != 0 {
		t.Fatalf("an unchanged favorite was sent again: %v", r.items)
	}

	// new metadata (no route changes it today; a future one, or a repair, goes through the same trigger)
	e.app.db.Exec(`UPDATE items SET meta_enc=? WHERE id=?`, rb(90), i2)
	if r = admin.since("/api/items", cur); !same(r.items, i2) {
		t.Fatalf("meta: %+v", r)
	}
	cur = r.cursor

	// trashed: out of the library, into the trash
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i1, i2}}, true)
	r = admin.since("/api/items", cur)
	if len(r.items) != 0 || !same(r.removed, i1, i2) {
		t.Fatalf("trash, library: %+v", r)
	}
	cur = r.cursor
	// (the trash's changes name every library change as not in the trash: it can't tell a restore from a favorite)
	tr := admin.since("/api/trash", tcur)
	if !same(tr.items, i1, i2) || !same(tr.removed, pending) {
		t.Fatalf("trash, trash: %+v", tr)
	}
	if x := tr.raw["items"].([]any)[0].(map[string]any); x["trashed_at"] == nil || x["purge_at"] == nil {
		t.Fatalf("trash record without its dates: %v", x)
	}
	tcur = tr.cursor

	// restored: back in the library, out of the trash
	admin.do("POST", "/api/items/restore", map[string]any{"item_ids": []string{i1}}, true)
	if r = admin.since("/api/items", cur); !same(r.items, i1) || len(r.removed) != 0 {
		t.Fatalf("restore, library: %+v", r)
	}
	cur = r.cursor
	if tr = admin.since("/api/trash", tcur); len(tr.items) != 0 || !same(tr.removed, i1) {
		t.Fatalf("restore, trash: %+v", tr)
	}
	tcur = tr.cursor

	// purged: a tombstone, in both lists (the library dropped it already; once more does no harm)
	admin.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{i2}}, true)
	if tr = admin.since("/api/trash", tcur); len(tr.items) != 0 || !same(tr.removed, i2) {
		t.Fatalf("purge, trash: %+v", tr)
	}
	if r = admin.since("/api/items", cur); len(r.items) != 0 || !same(r.removed, i2) {
		t.Fatalf("purge, library: %+v", r)
	}
	// an unfinished upload discarded leaves no tombstone
	cur = r.cursor
	gone := e.newItem(admin, 10)
	admin.do("DELETE", "/api/items/"+gone, nil, true)
	if r = admin.since("/api/items", cur); len(r.removed) != 0 || r.cursor != cur {
		t.Fatalf("aborted upload: %+v", r)
	}

	// the expired trash, emptied by the janitor, is a tombstone too
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i1}}, true)
	tcur = admin.since("/api/trash", tcur).cursor
	e.app.db.Exec(`UPDATE items SET trashed_at=trashed_at-31*86400 WHERE id=?`, i1) // (the session would expire with the clock moved on)
	tcur = admin.since("/api/trash", tcur).cursor
	e.app.purgeExpiredTrash()
	if tr = admin.since("/api/trash", tcur); !same(tr.removed, i1) {
		t.Fatalf("expired: %+v", tr)
	}

	// what the whole list says and what the changes say agree
	if len(admin.since("/api/items", admin.cursorOf("/api/items")).items) != 0 {
		t.Fatal("changes after a fresh whole list")
	}
}

// Many changes in one second (one request, one transaction: a whole selection trashed) still come one by one, in
// order, page by page, none twice and none left out.
func TestSincePagesChangesThatShareAMoment(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	at := time.Now()
	e.app.now = func() time.Time { return at } // every change in the same second (and millisecond)
	var ids []string
	for range 7 {
		ids = append(ids, e.readyItem(admin))
	}
	cur := admin.cursorOf("/api/items")
	old := listPage
	listPage = 3
	t.Cleanup(func() { listPage = old })
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": ids[:5]}, true)
	admin.do("POST", "/api/items/favorite", map[string]any{"item_ids": ids[5:], "favorite": true}, true)
	admin.do("POST", "/api/trash/purge", map[string]any{"item_ids": ids[:2]}, true)

	var items, removed []string
	pages := 0
	for {
		r := admin.since("/api/items", cur)
		pages++
		if n := len(r.items) + len(r.removed); n > 3 {
			t.Fatalf("page of %d", n)
		}
		items, removed = append(items, r.items...), append(removed, r.removed...)
		cur = r.cursor
		if !r.more {
			break
		}
		if pages > 10 {
			t.Fatal("the pages don't end")
		}
	}
	// trashed 5 (removed), 2 favorites (items); the 2 purged since are their tombstones now, each once
	if !same(items, ids[5:]...) || !same(removed, ids[:5]...) || pages != 3 {
		t.Fatalf("items %v removed %v pages %d", items, removed, pages)
	}
	// and the cursor in the end is where the account stands
	if r := admin.since("/api/items", cur); len(r.items)+len(r.removed) != 0 || r.more {
		t.Fatalf("after the last page: %+v", r)
	}
}

func TestSinceTombstonesArePrunedAndOldCursorsReset(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	i1, i2 := e.readyItem(admin), e.readyItem(admin)
	old := admin.cursorOf("/api/items")
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{i1}}, true)
	admin.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{i1}}, true)
	mid := admin.cursorOf("/api/items")

	// younger than 30 days: kept
	e.app.now = func() time.Time { return time.Now().Add(29 * 24 * time.Hour) }
	e.app.pruneTombstones()
	if r := admin.since("/api/items", old); r.reset || !same(r.removed, i1) {
		t.Fatalf("before the retention: %+v", r)
	}
	// older: pruned, and a cursor from before it can't be served any more
	e.app.now = func() time.Time { return time.Now().Add(31 * 24 * time.Hour) }
	e.app.pruneTombstones()
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM item_tombstones`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d tombstones left", n)
	}
	r := admin.since("/api/items", old)
	if !r.reset || len(r.items)+len(r.removed) != 0 || r.cursor == "" {
		t.Fatalf("an old cursor must reset: %+v", r)
	}
	// a cursor from after the pruned tombstone goes on as before
	admin.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{i2}, "favorite": true}, true)
	if r := admin.since("/api/items", mid); r.reset || !same(r.items, i2) {
		t.Fatalf("a newer cursor: %+v", r)
	}
	// the trash resets the same way
	if r := admin.since("/api/trash", old); !r.reset {
		t.Fatal("trash: an old cursor must reset")
	}
}

func TestSinceCursorsBelongToTheirAccountAndDatabase(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	a1 := e.readyItem(admin)
	acur, bcur := admin.cursorOf("/api/items"), bob.cursorOf("/api/items")
	b1 := e.readyItem(bob)
	bob.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{b1}, "favorite": true}, true)
	// bob's changes never reach admin, and the other way round
	if r := admin.since("/api/items", acur); len(r.items)+len(r.removed) != 0 || r.cursor != acur {
		t.Fatalf("admin sees bob's changes: %+v", r)
	}
	if r := bob.since("/api/items", bcur); !same(r.items, b1) {
		t.Fatalf("bob: %+v", r)
	}
	admin.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{a1}}, true)
	admin.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{a1}}, true)
	if r := bob.since("/api/items", bcur); len(r.removed) != 0 {
		t.Fatalf("bob sees admin's tombstone: %+v", r)
	}

	// a cursor ahead of the account (a database put back by hand), from another epoch (a restore), or unreadable
	epoch := strings.Split(acur, ".")[0]
	if r := admin.since("/api/items", epoch+".999999"); !r.reset {
		t.Fatal("a cursor ahead of the account must reset")
	}
	if r := admin.since("/api/items", "0123456789abcdef.0"); !r.reset {
		t.Fatal("another epoch must reset")
	}
	for _, bad := range []string{"x", "1.2", epoch, epoch + ".-1", epoch + ".1a", epoch + ".99999999999999999999"} {
		if code, _ := admin.do("GET", "/api/items?since="+url.QueryEscape(bad), nil, false); code != 400 {
			t.Fatalf("since=%q: %d", bad, code)
		}
	}
	// ?after paging and the whole list are as they were
	if code, out := admin.do("GET", "/api/items", nil, false); code != 200 || out["next"] != "" {
		t.Fatalf("whole list: %d %v", code, out)
	}
}

func TestSinceSurvivesARestartAndRestoreStartsANewEpoch(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	i1 := e.readyItem(admin)
	cur := admin.cursorOf("/api/items")
	// opening the database again (a restart) keeps numbers, epoch and triggers
	db2, err := openDB(e.app.dataDir + "/app.db")
	if err != nil {
		t.Fatal(err)
	}
	db2.Close()
	admin.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{i1}, "favorite": true}, true)
	if r := admin.since("/api/items", cur); r.reset || !same(r.items, i1) {
		t.Fatalf("after a restart: %+v", r)
	}
	e.app.db.Close()
	if err := runAfterRestore(e.app.dataDir); err != nil {
		t.Fatal(err)
	}
	db, err := openDB(e.app.dataDir + "/app.db")
	if err != nil {
		t.Fatal(err)
	}
	e.app.db = db
	admin = e.login("admin@x.org", ab) // a restore ends every session
	if r := admin.since("/api/items", cur); !r.reset {
		t.Fatal("a cursor from before a restore must reset")
	}
}

func TestSinceLeavesNothingOfADeletedAccount(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	b1, b2 := e.readyItem(bob), e.readyItem(bob)
	bob.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{b1}}, true)
	bob.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{b1}}, true)
	_ = b2
	bobID := e.userID("bob@x.org")
	if code, _ := admin.do("DELETE", "/api/admin/users/"+bobID, nil, true); code != 200 {
		t.Fatalf("delete account: %d", code)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM item_tombstones WHERE user_id=?`, bobID).Scan(&n)
	if n != 0 {
		t.Fatalf("%d tombstones of a deleted account", n)
	}
}

func TestSinceForTheDemoOnlyReads(t *testing.T) {
	_, _, demo, _, item := demoEnv(t)
	cur := demo.cursorOf("/api/items")
	if r := demo.since("/api/items", cur); r.reset || len(r.items) != 0 {
		t.Fatalf("demo: %+v", r)
	}
	if code, _ := demo.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{item}, "favorite": true}, true); code == 200 {
		t.Fatal("the demo changed something")
	}
}

// TestSinceCostsLittle measures, for the report in CHANGELOG.md, what one live update costs a device with a 3,000-item
// library: the whole list (what the apps fetched before) against ?since after one change and after a 200-photo
// backup. Run with -v to see the numbers.
func TestSinceCostsLittle(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	uid := e.userID("admin@x.org")
	// synthetic records of the sizes a real upload sends: a wrapped key, ~300 bytes of encrypted metadata
	tx, _ := e.app.db.Begin()
	for i := range 3000 {
		tx.Exec(`INSERT INTO items(id,user_id,kind,state,size_bytes,segment_count,wrapped_item_key,meta_enc,has_thumb,has_preview,created_at) VALUES (?,?,?,?,?,?,?,?,1,1,?)`,
			randID(), uid, "image", "ready", 10, 1, rb(wrappedLen), rb(300), 1_700_000_000+i)
	}
	tx.Commit()
	size := func(path string) (int, map[string]any) {
		code, raw := admin.getRaw(path)
		if code != 200 {
			t.Fatalf("%s: %d", path, code)
		}
		var out map[string]any
		json.Unmarshal(raw, &out)
		return len(raw), out
	}
	full, out := size("/api/items")
	cur := out["cursor"].(string)
	if n := len(out["items"].([]any)); n != 2000 { // the first page; the rest follows with ?after
		t.Fatalf("first page %d", n)
	}
	rest, _ := size("/api/items?after=" + url.QueryEscape(out["next"].(string)))
	full += rest

	var id string
	e.app.db.QueryRow(`SELECT id FROM items LIMIT 1`).Scan(&id)
	admin.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{id}, "favorite": true}, true)
	one, o1 := size("/api/items?since=" + url.QueryEscape(cur))
	if len(o1["items"].([]any)) != 1 {
		t.Fatalf("one change: %v", o1)
	}
	cur = o1["cursor"].(string)
	for range 200 {
		e.readyItem(admin)
	}
	backup, o2 := size("/api/items?since=" + url.QueryEscape(cur))
	if len(o2["items"].([]any)) != 200 {
		t.Fatalf("200 new: %d", len(o2["items"].([]any)))
	}
	t.Logf("3,000 items: whole list %d bytes in 2 requests, records to decrypt or compare: 3000", full)
	t.Logf("one favorite: since %d bytes, 1 record (%.0f× less)", one, float64(full)/float64(one))
	t.Logf("200 new photos at once: since %d bytes, 200 records (whole list then: ~%d bytes)", backup, full*3200/3000)
	if one*100 > full {
		t.Fatal(fmt.Sprintf("since is not much smaller: %d vs %d", one, full))
	}
}

// A database from before incremental lists gets the numbers, the tombstones and the triggers; its items keep rev 0.
func TestSinceMigratesAnOlderDatabase(t *testing.T) {
	path := t.TempDir() + "/app.db"
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DROP TRIGGER items_rev_upd`, `DROP TRIGGER items_rev_del`, `DROP TRIGGER items_tomb_user`, `DROP INDEX items_rev`,
		`DROP TABLE item_tombstones`, `ALTER TABLE items DROP COLUMN rev`, `ALTER TABLE users DROP COLUMN items_rev`,
		`ALTER TABLE users DROP COLUMN tomb_floor`, `DELETE FROM settings WHERE key='sync_epoch'`,
		`INSERT INTO users(id,email,role,kdf,auth_hash,pubkey,wrapped_master_pw,wrapped_master_recovery,wrapped_privkey,recovery_hash,created_at) VALUES ('u1','a@x.org','user','k','h','p','w','r','v','rh',1)`,
		`INSERT INTO items(id,user_id,kind,state,size_bytes,segment_count,created_at) VALUES ('i1','u1','image','ready',1,1,1)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	db.Close()
	db, err = openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var rev, urev int64
	var epoch string
	db.QueryRow(`SELECT rev FROM items WHERE id='i1'`).Scan(&rev)
	db.QueryRow(`SELECT value FROM settings WHERE key='sync_epoch'`).Scan(&epoch)
	if rev != 0 || len(epoch) != 16 {
		t.Fatalf("after the migration: rev %d epoch %q", rev, epoch)
	}
	db.Exec(`UPDATE items SET favorite=1 WHERE id='i1'`)
	db.QueryRow(`SELECT i.rev, u.items_rev FROM items i JOIN users u ON u.id=i.user_id WHERE i.id='i1'`).Scan(&rev, &urev)
	if rev != 1 || urev != 1 {
		t.Fatalf("a change after the migration: rev %d, account %d", rev, urev)
	}
}
