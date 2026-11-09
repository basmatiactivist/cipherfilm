package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// seedPage gives an account n ready items (and n index entries) with metaLen bytes of metadata each; trashed puts
// the items in the trash.
func seedPage(t *testing.T, e *env, email string, n, metaLen int, trashed bool) {
	t.Helper()
	var uid string
	if err := e.app.db.QueryRow(`SELECT id FROM users WHERE email=?`, email).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	meta := strings.Repeat("A", metaLen)
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("%s%024x", uid[:8], i+1)
		var tr any
		if trashed {
			tr = 2000 + i
		}
		if _, err := e.app.db.Exec(`INSERT INTO items(id,user_id,kind,size_bytes,segment_count,created_at,state,wrapped_item_key,meta_enc,trashed_at) VALUES(?,?,'image',1,1,?,'ready','k',?,?)`, id, uid, 1000+i, meta, tr); err != nil {
			t.Fatal(err)
		}
		if _, err := e.app.db.Exec(`INSERT INTO item_index(item_id,user_id,data_enc,updated_at) VALUES(?,?,?,?)`, id, uid, meta, 1000+i); err != nil {
			t.Fatal(err)
		}
	}
}

func getWithin(c *client, path string, d time.Duration) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", c.e.srv.URL+path, nil)
	resp, err := c.c.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	buf := make([]byte, 64<<10)
	for {
		if _, err := resp.Body.Read(buf); err != nil {
			break
		}
	}
	return resp.StatusCode, nil
}

// A list page cut by its byte budget gives its database connection back before the next query: with all but one of
// the pooled connections busy elsewhere, it still completes.
func TestCutPageReleasesConnection(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	live, _ := e.acceptInvite(e.invite(admin, "live@x.org"))
	bin, _ := e.acceptInvite(e.invite(admin, "bin@x.org"))
	seedPage(t, e, "live@x.org", 30, 1000, false)
	seedPage(t, e, "bin@x.org", 30, 1000, true)
	defer func(n int) { pageBytes = n }(pageBytes)
	pageBytes = 5000
	ctx := context.Background()
	held := e.app.db.Stats().MaxOpenConnections - 1
	for i := 0; i < held; i++ {
		c, err := e.app.db.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
	}
	for _, tc := range []struct {
		c    *client
		path string
	}{{live, "/api/items"}, {bin, "/api/trash"}, {live, "/api/index"}} {
		code, err := getWithin(tc.c, tc.path, 5*time.Second)
		if err != nil || code != 200 {
			t.Fatalf("%s with one free connection: %d %v", tc.path, code, err)
		}
	}
}

// Many concurrent cut pages of several accounts never leave the pool stuck for everyone else.
func TestConcurrentCutPagesDoNotBlockOthers(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	a1, _ := e.acceptInvite(e.invite(admin, "a1@x.org"))
	a2, _ := e.acceptInvite(e.invite(admin, "a2@x.org"))
	other, _ := e.acceptInvite(e.invite(admin, "other@x.org"))
	seedPage(t, e, "a1@x.org", 30, 1000, false)
	seedPage(t, e, "a2@x.org", 30, 1000, false)
	defer func(n int) { pageBytes = n }(pageBytes)
	pageBytes = 5000
	for round := 0; round < 150; round++ {
		done := make(chan error, 8)
		for _, c := range []*client{a1, a1, a1, a1, a2, a2, a2, a2} {
			go func(c *client) {
				code, err := getWithin(c, "/api/items", 10*time.Second)
				if err == nil && code != 200 && code != 429 {
					err = fmt.Errorf("status %d", code)
				}
				done <- err
			}(c)
		}
		for i := 0; i < 8; i++ {
			if err := <-done; err != nil {
				t.Fatalf("round %d: %v", round, err)
			}
		}
	}
	if code, err := getWithin(other, "/api/me", 5*time.Second); err != nil || code != 200 {
		t.Fatalf("another account after the rounds: %d %v", code, err)
	}
}
