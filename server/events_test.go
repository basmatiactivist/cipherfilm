package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// One event of the live-update stream; a heartbeat (a comment line) has the name ":".
type sseEvent struct {
	name string
	data map[string]any
}

type sseStream struct {
	resp   *http.Response
	events chan sseEvent
	done   chan struct{} // closed when the server ends the stream
}

// events opens the client's live-update stream; the status is that of the answer (the stream only if 200).
func (c *client) events() (*sseStream, int) {
	c.e.t.Helper()
	req, _ := http.NewRequest("GET", c.e.srv.URL+"/api/events", nil)
	resp, err := c.c.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, resp.StatusCode
	}
	s := &sseStream{resp: resp, events: make(chan sseEvent, 100), done: make(chan struct{})}
	c.e.t.Cleanup(func() { resp.Body.Close() })
	go func() {
		defer close(s.done)
		sc := bufio.NewScanner(resp.Body)
		ev := sseEvent{}
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if ev.name != "" {
					s.events <- ev
				}
				ev = sseEvent{}
			case strings.HasPrefix(line, ":"):
				ev.name = ":"
			case strings.HasPrefix(line, "event: "):
				ev.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev.data)
			}
		}
	}()
	return s, 200
}

// next waits for the next event that isn't a heartbeat.
func (s *sseStream) next(t *testing.T, within time.Duration) (sseEvent, bool) {
	t.Helper()
	timeout := time.After(within)
	for {
		select {
		case ev := <-s.events:
			if ev.name == ":" {
				continue
			}
			return ev, true
		case <-timeout:
			return sseEvent{}, false
		}
	}
}

func (s *sseStream) ready(t *testing.T) uint64 {
	t.Helper()
	ev, ok := s.next(t, 2*time.Second)
	if !ok || ev.name != "ready" {
		t.Fatalf("no ready event: %v", ev)
	}
	return uint64(ev.data["v"].(float64))
}

// changed waits for a "changed" ping and returns what it names.
func (s *sseStream) changed(t *testing.T) (what []string, v uint64) {
	t.Helper()
	ev, ok := s.next(t, 3*time.Second)
	if !ok || ev.name != "changed" {
		t.Fatalf("no changed event: %v %v", ok, ev)
	}
	for _, x := range ev.data["what"].([]any) {
		what = append(what, x.(string))
	}
	return what, uint64(ev.data["v"].(float64))
}

// ended: the server closes the stream (after a "bye").
func (s *sseStream) ended(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(within):
		t.Fatal("the stream stayed open")
	}
}

func fastEvents(t *testing.T) {
	gap, beat := eventGap, eventHeartbeat
	eventGap, eventHeartbeat = 10*time.Millisecond, time.Hour
	t.Cleanup(func() { eventGap, eventHeartbeat = gap, beat })
}

func TestEventsNeedASession(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	if _, code := e.client().events(); code != 401 {
		t.Fatalf("without a session: %d", code)
	}
}

func TestEventsPingTheOtherDevicesOnEveryChange(t *testing.T) {
	fastEvents(t)
	e := newEnv(t)
	phone, ab := e.setupAdmin("admin@x.org")
	web := e.login("admin@x.org", ab)
	s, code := web.events()
	if code != 200 {
		t.Fatalf("events: %d", code)
	}
	if ct := s.resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	if s.resp.Header.Get("X-Accel-Buffering") != "no" || s.resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("headers %v", s.resp.Header)
	}
	v0 := s.ready(t)

	// an unfinished upload is not in the list yet: no ping until it is finalized
	id := e.newItem(phone, 10)
	phone.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	if ev, ok := s.next(t, 150*time.Millisecond); ok {
		t.Fatalf("ping before finalize: %v", ev)
	}
	if code, _ := phone.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true); code != 200 {
		t.Fatalf("finalize %d", code)
	}
	what, v1 := s.changed(t)
	if strings.Join(what, ",") != "items" || v1 <= v0 {
		t.Fatalf("finalize: %v v%d after v%d", what, v1, v0)
	}

	steps := []struct {
		name string
		do   func()
		want string
	}{
		{"favorite", func() {
			phone.do("POST", "/api/items/favorite", map[string]any{"item_ids": []string{id}, "favorite": true}, true)
		}, "items"},
		{"album", func() { phone.do("POST", "/api/albums", albumBody(), true) }, "albums"},
		{"trash", func() { phone.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{id}}, true) }, "items,trash,albums"},
		{"restore", func() { phone.do("POST", "/api/items/restore", map[string]any{"item_ids": []string{id}}, true) }, "items,trash,albums"},
		{"people", func() {
			phone.do("PUT", "/api/me/blobs/people", map[string]any{"data_enc": rb(60), "version": 0}, true)
		}, "people"},
		{"index", func() {
			phone.do("PUT", "/api/items/"+id+"/index", map[string]any{"data_enc": rb(60), "model": "laionb32"}, true)
		}, "index"},
	}
	last := v1
	for _, st := range steps {
		st.do()
		what, v := s.changed(t)
		if strings.Join(what, ",") != st.want || v <= last {
			t.Fatalf("%s: %v v%d (want %s after v%d)", st.name, what, v, st.want, last)
		}
		last = v
	}
	// purging from the trash
	phone.do("POST", "/api/items/trash", map[string]any{"item_ids": []string{id}}, true)
	s.changed(t)
	phone.do("POST", "/api/trash/purge", map[string]any{"item_ids": []string{id}}, true)
	if what, _ := s.changed(t); strings.Join(what, ",") != "trash" {
		t.Fatalf("purge: %v", what)
	}
	// reads change nothing
	phone.do("GET", "/api/items", nil, false)
	phone.do("GET", "/api/albums", nil, false)
	if ev, ok := s.next(t, 150*time.Millisecond); ok {
		t.Fatalf("ping after a read: %v", ev)
	}
}

func TestEventsNeverReachAnotherAccount(t *testing.T) {
	fastEvents(t)
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	sb, _ := bob.events()
	sa, _ := admin.events()
	sb.ready(t)
	sa.ready(t)
	e.readyItem(admin)
	admin.do("POST", "/api/albums", albumBody(), true)
	sa.changed(t)
	if ev, ok := sb.next(t, 300*time.Millisecond); ok {
		t.Fatalf("bob was told of admin's change: %v", ev)
	}
	e.readyItem(bob)
	sb.changed(t)
}

func TestEventsBurstArrivesAsFewPings(t *testing.T) {
	fastEvents(t)
	eventGap = 300 * time.Millisecond
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	s, _ := admin.events()
	s.ready(t)
	for range 8 {
		admin.do("POST", "/api/albums", albumBody(), true)
	}
	e.readyItem(admin)
	pings := 0
	seen := map[string]bool{}
	for {
		ev, ok := s.next(t, 700*time.Millisecond)
		if !ok {
			break
		}
		pings++
		for _, x := range ev.data["what"].([]any) {
			seen[x.(string)] = true
		}
	}
	if pings == 0 || pings > 4 || !seen["albums"] || !seen["items"] {
		t.Fatalf("%d pings for 9 changes, saw %v", pings, seen)
	}
}

func TestEventsEndWithTheSession(t *testing.T) {
	fastEvents(t)
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")

	// signing out here
	web := e.login("admin@x.org", ab)
	s, _ := web.events()
	s.ready(t)
	web.do("POST", "/api/auth/logout", nil, true)
	s.ended(t, 2*time.Second)

	// signed out from another device
	web = e.login("admin@x.org", ab)
	s, _ = web.events()
	s.ready(t)
	var pub string
	for _, x := range sessionList(t, admin) {
		if x["current"] != true {
			pub = x["id"].(string)
		}
	}
	if code, _ := admin.do("DELETE", "/api/me/sessions/"+pub, nil, true); code != 200 {
		t.Fatalf("end session: %d", code)
	}
	s.ended(t, 2*time.Second)
	if _, code := web.events(); code != 401 {
		t.Fatalf("after sign-out: %d", code)
	}

	// the account is disabled or deleted by an admin
	bob, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	sb, _ := bob.events()
	sb.ready(t)
	bobID := e.userID("bob@x.org")
	admin.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"status": "disabled"}, true)
	sb.ended(t, 2*time.Second)
	admin.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"status": "active"}, true)
	bob = e.login("bob@x.org", bb)
	sb, _ = bob.events()
	sb.ready(t)
	admin.do("DELETE", "/api/admin/users/"+bobID, nil, true)
	sb.ended(t, 2*time.Second)

	// streams of the account that stays signed in are not affected
	keep, _ := admin.events()
	keep.ready(t)
	other := e.login("admin@x.org", ab)
	o2, _ := other.events()
	o2.ready(t)
	admin.do("POST", "/api/me/sessions/end-others", nil, true)
	o2.ended(t, 2*time.Second)
	admin.do("POST", "/api/albums", albumBody(), true)
	keep.changed(t)
}

func (e *env) userID(email string) string {
	var id string
	if err := e.app.db.QueryRow(`SELECT id FROM users WHERE email=?`, email).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

// The heartbeat keeps the stream going past the short read deadline every request starts with, and checks the
// session: one that expired (or was removed by the command line, in another process) ends the stream.
func TestEventsHeartbeatOutlivesTheReadDeadlineAndChecksTheSession(t *testing.T) {
	fastEvents(t)
	read := jsonReadTime
	jsonReadTime, eventHeartbeat = 150*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() { jsonReadTime = read })
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	s, _ := admin.events()
	s.ready(t)
	beats := 0
	for end := time.After(600 * time.Millisecond); beats >= 0; {
		select {
		case ev := <-s.events:
			if ev.name == ":" {
				beats++
			}
		case <-s.done:
			t.Fatalf("the stream ended after %d heartbeats", beats)
		case <-end:
			if beats < 5 {
				t.Fatalf("%d heartbeats", beats)
			}
			admin.do("POST", "/api/albums", albumBody(), true)
			s.changed(t)
			beats = -1
		}
	}
	e.app.db.Exec(`UPDATE sessions SET expires_at=?`, time.Now().Add(-time.Minute).Unix())
	s.ended(t, time.Second)
}

func TestEventsAreLimitedAndLeaveNothingBehind(t *testing.T) {
	fastEvents(t)
	per := streamsPerSess
	streamsPerSess = 2
	t.Cleanup(func() { streamsPerSess = per })
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	a1, _ := admin.events()
	a2, _ := admin.events()
	a1.ready(t)
	a2.ready(t)
	if _, code := admin.events(); code != 429 {
		t.Fatalf("a third stream of one session: %d", code)
	}
	// another session of the account still gets one
	other := e.login("admin@x.org", ab)
	o, code := other.events()
	if code != 200 {
		t.Fatalf("another session: %d", code)
	}
	o.ready(t)
	// a stream the client closes is gone from the server too
	a1.resp.Body.Close()
	deadline := time.Now().Add(2 * time.Second)
	for e.app.live.count() != 2 {
		if time.Now().After(deadline) {
			t.Fatalf("%d streams still open", e.app.live.count())
		}
		admin.do("POST", "/api/albums", albumBody(), true) // a write notices the closed connection
		time.Sleep(20 * time.Millisecond)
	}
	if _, code := admin.events(); code != 200 {
		t.Fatalf("after one closed: %d", code)
	}
}

func TestEventsForTheDemoOnlyRead(t *testing.T) {
	fastEvents(t)
	_, _, demo, _, _ := demoEnv(t)
	s, code := demo.events()
	if code != 200 {
		t.Fatalf("demo: %d", code)
	}
	s.ready(t)
}
