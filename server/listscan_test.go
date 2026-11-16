package main

import (
	"strings"
	"testing"
	"time"
)

// planOf is SQLite's plan for a query, its steps joined.
func planOf(t *testing.T, e *env, q string, args ...any) string {
	t.Helper()
	rows, err := e.app.db.Query(`EXPLAIN QUERY PLAN `+q, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var steps []string
	for rows.Next() {
		var id, parent, notused int
		var detail string
		rows.Scan(&id, &parent, &notused, &detail)
		steps = append(steps, detail)
	}
	return strings.Join(steps, " | ")
}

// A library page reads its own rows: the library's index holds no trashed rows, and the ?after cursor is a range of
// it. An index page with ?model= is a range of that model's entries.
func TestListPagesAreIndexRanges(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	lib := `SELECT id FROM items INDEXED BY items_lib WHERE user_id=? AND state='ready' AND trashed_at IS NULL AND created_at <= ? AND (created_at < ? OR id > ?) ORDER BY created_at DESC, id LIMIT ?`
	if p := planOf(t, e, lib, "u", 5, 5, "x", 10); !strings.Contains(p, "items_lib (user_id=? AND created_at<?)") || strings.Contains(p, "TEMP B-TREE") {
		t.Fatalf("library page plan: %s", p)
	}
	idx := `SELECT item_id FROM item_index WHERE user_id=? AND model=? AND updated_at >= ? AND (updated_at > ? OR item_id > ?) ORDER BY updated_at, item_id LIMIT ?`
	if p := planOf(t, e, idx, "u", "laionb32", 5, 5, "x", 10); !strings.Contains(p, "item_index_model (user_id=? AND model=? AND updated_at>?)") || strings.Contains(p, "TEMP B-TREE") {
		t.Fatalf("index page plan: %s", p)
	}
}

// Pages of the library come out whole and in order across trashed rows and equal times, by the cursor.
func TestLibraryPagesSkipTheTrashByIndex(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	uid := e.userID("admin@x.org")
	// 30 items at 10 times (3 each), every other one trashed
	for i := 0; i < 30; i++ {
		var tr any
		if i%2 == 1 {
			tr = 5
		}
		e.app.db.Exec(`INSERT INTO items(id,user_id,kind,size_bytes,segment_count,created_at,state,wrapped_item_key,meta_enc,trashed_at) VALUES(printf('%032x', ?),?,'image',1,1,?,'ready','k','m',?)`, i, uid, 100+i/3, tr)
	}
	defer func(n int) { listPage = n }(listPage)
	listPage = 4
	seen, path := map[string]bool{}, "/api/items"
	var lastTS float64 = 1 << 50
	for pages := 0; pages < 10; pages++ {
		_, out := admin.do("GET", path, nil, false)
		for _, x := range out["items"].([]any) {
			m := x.(map[string]any)
			if seen[m["id"].(string)] || m["created_at"].(float64) > lastTS {
				t.Fatalf("out of order or twice: %v", m)
			}
			seen[m["id"].(string)], lastTS = true, m["created_at"].(float64)
		}
		if out["next"] == "" {
			break
		}
		path = "/api/items?after=" + out["next"].(string)
	}
	if len(seen) != 15 {
		t.Fatalf("library pages gave %d items, want 15", len(seen))
	}
}

// Every list page of one account at once leaves pooled connections for other accounts' requests.
func TestListPagesLeaveAConnectionForOthers(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	other, _ := e.acceptInvite(e.invite(admin, "other@x.org"))
	// the list places of all accounts are taken
	for i := 0; i < cap(listsInAll); i++ {
		listsInAll <- struct{}{}
	}
	defer func() {
		for i := 0; i < cap(listsInAll); i++ {
			<-listsInAll
		}
	}()
	if cap(listsInAll) >= e.app.db.Stats().MaxOpenConnections || listPerUser >= cap(listsInAll) {
		t.Fatalf("list places %d, per account %d, pool %d", cap(listsInAll), listPerUser, e.app.db.Stats().MaxOpenConnections)
	}
	// a waiting page holds no connection: another account's request goes through
	go getWithin(admin, "/api/items", 2*time.Second)
	if code, err := getWithin(other, "/api/me", 2*time.Second); err != nil || code != 200 {
		t.Fatalf("another account while list pages wait: %d %v", code, err)
	}
}
