package main

import (
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fullUsed is the account's storage summed from scratch, what users.used_bytes must always equal.
func fullUsed(e *env, userID string) int64 {
	e.t.Helper()
	var used int64
	if err := e.app.db.QueryRow(`SELECT `+usedBytesSQL("?"), userID, userID, userID).Scan(&used); err != nil {
		e.t.Fatal(err)
	}
	return used
}

func checkCounters(e *env, step string) {
	e.t.Helper()
	rows, err := e.app.db.Query(`SELECT id, email, used_bytes FROM users`)
	if err != nil {
		e.t.Fatal(err)
	}
	type row struct {
		id, email string
		used      int64
	}
	var all []row
	for rows.Next() {
		var r row
		rows.Scan(&r.id, &r.email, &r.used)
		all = append(all, r)
	}
	rows.Close()
	for _, r := range all {
		if want := fullUsed(e, r.id); r.used != want {
			e.t.Fatalf("%s: %s counter %d, full sum %d", step, r.email, r.used, want)
		}
	}
}

// The counter equals the full sum after any sequence of the writes that change stored bytes: segments, thumbnails
// and previews, finalize, replacements, metadata, index entries, the people document, aborts, trash and purge, the
// cleanup jobs, and an account's deletion (whose cascade deletes rows of other tables).
func TestUsageCounterMatchesTheFullSum(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	users := []*client{admin}
	for _, m := range []string{"bob@x.org", "carol@x.org"} {
		c, _ := e.acceptInvite(e.invite(admin, m))
		users = append(users, c)
	}
	e.app.db.Exec(`UPDATE users SET quota_bytes=?`, 64<<20)
	rng := rand.New(rand.NewSource(1))
	type state struct{ open, ready, trashed []string }
	st := make([]state, len(users))
	pick := func(s []string) string { return s[rng.Intn(len(s))] }
	drop := func(s []string, id string) []string {
		for i, v := range s {
			if v == id {
				return append(s[:i:i], s[i+1:]...)
			}
		}
		return s
	}
	blobVer := make([]int64, len(users))
	done := map[int]int{}
	for step := 0; step < 400; step++ {
		ui := rng.Intn(len(users))
		c, s := users[ui], &st[ui]
		op := rng.Intn(14)
		code := 0
		switch {
		case op == 0 || len(s.open)+len(s.ready) == 0:
			size := int64(rng.Intn(3000) + 1)
			id := e.newItem(c, size)
			code, _ = c.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(size))))
			s.open = append(s.open, id)
			op = 0
		case op == 1 && len(s.open) > 0:
			code, _ = c.put("/api/items/"+pick(s.open)+"/thumb", randBytes(rng.Intn(4000)+1))
		case op == 2 && len(s.open) > 0:
			code, _ = c.put("/api/items/"+pick(s.open)+"/preview", randBytes(rng.Intn(8000)+1))
		case op == 3 && len(s.open) > 0:
			id := pick(s.open)
			c.put("/api/items/"+id+"/thumb", randBytes(rng.Intn(4000)+1))
			if code, _ = c.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code == 200 {
				s.open, s.ready = drop(s.open, id), append(s.ready, id)
			}
		case op == 4 && len(s.open) > 0:
			id := pick(s.open)
			code, _ = c.do("DELETE", "/api/items/"+id, nil, true)
			s.open = drop(s.open, id)
		case op == 5 && len(s.ready) > 0:
			code, _ = c.put("/api/items/"+pick(s.ready)+"/replace/thumb", randBytes(rng.Intn(4000)+1))
		case op == 6 && len(s.ready) > 0:
			code, _ = c.put("/api/items/"+pick(s.ready)+"/replace/preview", randBytes(rng.Intn(8000)+1))
		case op == 7 && len(s.ready) > 0:
			code, _ = c.do("PUT", "/api/items/"+pick(s.ready)+"/meta", map[string]any{"meta_enc": rb(41 + rng.Intn(300))}, true)
		case op == 8 && len(s.ready)+len(s.open) > 0:
			id := pick(append(append([]string{}, s.ready...), s.open...))
			code, _ = c.do("PUT", "/api/items/"+id+"/index", map[string]any{"data_enc": rb(rng.Intn(600) + 1), "model": "laionb32/1"}, true)
		case op == 9:
			var out map[string]any
			if code, out = c.do("PUT", "/api/me/blobs/people", map[string]any{"data_enc": rb(rng.Intn(2000) + 1), "version": blobVer[ui]}, true); code == 200 {
				blobVer[ui] = int64(out["version"].(float64))
			}
		case op == 10 && len(s.ready) > 0:
			id := pick(s.ready)
			code, _ = c.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{id}}, true)
			s.ready, s.trashed = drop(s.ready, id), append(s.trashed, id)
		case op == 11 && len(s.trashed) > 0:
			id := pick(s.trashed)
			if rng.Intn(2) == 0 {
				code, _ = c.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{id}}, true)
			} else { // the trash's expiry
				e.app.db.Exec(`UPDATE items SET trashed_at=1 WHERE id=?`, id)
				e.app.purgeExpiredTrash()
				code = 200
			}
			s.trashed = drop(s.trashed, id)
		case op == 12 && len(s.open) > 0: // a stale upload swept
			id := pick(s.open)
			e.app.db.Exec(`UPDATE items SET created_at=1 WHERE id=?`, id)
			e.app.sweepStale()
			code = 200
			s.open = drop(s.open, id)
		case op == 13:
			if rng.Intn(4) == 0 {
				code, _ = c.do("DELETE", "/api/index", nil, true) // the index and the people document
				blobVer[ui] = 0
			} else {
				code, _ = c.do("DELETE", "/api/me/blobs/people", nil, true)
				blobVer[ui] = 0
			}
		}
		if code == 200 {
			done[op]++
		}
		checkCounters(e, fmt.Sprintf("step %d op %d", step, op))
	}
	// every kind of write happened, or the check proves less than it claims
	for op := 0; op < 14; op++ {
		if done[op] == 0 {
			t.Errorf("op %d never succeeded (%v)", op, done)
		}
	}
	if fullUsed(e, e.userID("bob@x.org")) == 0 || fullUsed(e, e.userID("carol@x.org")) == 0 {
		t.Fatal("the sequence stored nothing; the check proves nothing")
	}
	// an account's deletion cascades to its items, index entries and documents; the others' counters stay right
	if _, err := e.app.db.Exec(`DELETE FROM users WHERE email='carol@x.org'`); err != nil {
		t.Fatal(err)
	}
	checkCounters(e, "after deleting an account")
	// what the apps see
	bob := users[1]
	if _, out := bob.do("GET", "/api/me/usage", nil, false); int64(out["used_bytes"].(float64)) != fullUsed(e, e.userID("bob@x.org")) {
		t.Fatalf("usage shows %v", out["used_bytes"])
	}
}

// A database from before the counter (no column, no triggers) gets both at start, set from the full sums; and a
// counter that is off for any reason is set right again at the next start.
func TestUsageCounterIsSetAtStart(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.newItem(admin, 1000)
	admin.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(1000))))
	admin.put("/api/items/"+id+"/thumb", randBytes(700))
	admin.do("PUT", "/api/items/"+id+"/index", map[string]any{"data_enc": rb(300), "model": "laionb32/1"}, true)
	admin.do("PUT", "/api/me/blobs/people", map[string]any{"data_enc": rb(500), "version": 0}, true)
	uid := e.userID("admin@x.org")
	want := fullUsed(e, uid)
	if want == 0 {
		t.Fatal("nothing stored")
	}
	db := e.app.db
	for _, q := range usageTriggers[:9] { // the DROPs
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`ALTER TABLE users DROP COLUMN used_bytes`); err != nil {
		t.Fatal(err)
	}
	if err := migrateUsage(db); err != nil {
		t.Fatal(err)
	}
	if got := e.app.usedBytes(uid); got != want {
		t.Fatalf("after the migration: %d, want %d", got, want)
	}
	db.Exec(`UPDATE users SET used_bytes=12345`)
	if err := migrateUsage(db); err != nil {
		t.Fatal(err)
	}
	if got := e.app.usedBytes(uid); got != want {
		t.Fatalf("after a restart: %d, want %d", got, want)
	}
	// and the triggers work again
	admin.put("/api/items/"+id+"/preview", randBytes(900))
	checkCounters(e, "after the migration")
}

// One account's large library must not slow another account's uploads: the quota check reads a counter, so its cost
// doesn't grow with the library, and 8 loops of the large account's quota-checking requests leave another account's
// reservation near its solo time.
func TestLargeLibraryDoesNotSlowOtherAccounts(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	big, _ := e.acceptInvite(e.invite(admin, "big@x.org"))
	bigID, victimID := e.userID("big@x.org"), e.userID("admin@x.org")
	const rows = 150000
	if _, err := e.app.db.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
		INSERT INTO items(id,user_id,kind,state,size_bytes,segment_count,stored_bytes,created_at)
		SELECT 'big'||i, ?, 'image', 'ready', 100, 1, 8300, 1 FROM n`, rows, bigID); err != nil {
		t.Fatal(err)
	}
	if got := e.app.usedBytes(bigID); got != rows*8300 {
		t.Fatalf("counter %d after the bulk insert", got)
	}
	// over its quota: every POST /api/items pays the quota check and is refused, without creating anything
	e.app.db.Exec(`UPDATE users SET quota_bytes=? WHERE id=?`, rows*8300+1, bigID)

	timeIt := func(n int, f func()) time.Duration {
		start := time.Now()
		for i := 0; i < n; i++ {
			f()
		}
		return time.Since(start) / time.Duration(n)
	}
	reserve := func(id string) func() {
		return func() {
			release, ok := e.app.reserveBytes(id, 1)
			if !ok {
				t.Error("reservation refused")
				return
			}
			release()
		}
	}
	timeIt(20, reserve(victimID))
	soloVictim := timeIt(200, reserve(victimID))
	soloBig := timeIt(200, func() { e.app.quotaLeft(bigID) })
	t.Logf("solo: victim reservation %v, quota check of the %d-row account %v", soloVictim, rows, soloBig)
	// the check of a 150,000-row account took about 20-45 ms when it summed the rows
	if soloBig > 2*time.Millisecond {
		t.Errorf("the quota check of a large account takes %v: it still grows with the library", soloBig)
	}

	for _, load := range []struct {
		name string
		f    func()
	}{
		{"POST /api/items over quota", func() {
			if code, _ := big.do("POST", "/api/items", map[string]any{"kind": "image", "size": 1000, "segment_count": 1}, true); code != 413 {
				t.Errorf("over-quota create: %d", code)
			}
		}},
		{"reservations", func() {
			if release, ok := e.app.reserveBytes(bigID, 1); ok {
				release()
			}
		}},
	} {
		var stop atomic.Bool
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for !stop.Load() {
					load.f()
				}
			}()
		}
		time.Sleep(50 * time.Millisecond)
		loaded := timeIt(50, reserve(victimID))
		stop.Store(true)
		wg.Wait()
		t.Logf("under 8 loops of the large account's %s: victim reservation %v", load.name, loaded)
		// with the full sum it took about 50 ms (POST loops) and 300 ms (reservation loops)
		if loaded > 10*time.Millisecond {
			t.Errorf("under %s the victim's reservation took %v", load.name, loaded)
		}
	}
}
