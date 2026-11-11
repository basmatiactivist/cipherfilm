package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"testing"
	"time"
)

// The published demo login can't make the server fetch and send search models, and the server passes through only
// a few at once for everyone else (older apps).
func TestDemoGetsNoModelsAndModelsAreFewAtOnce(t *testing.T) {
	fakeModelHost(t)
	_, _, demo, bob, _ := demoEnv(t)
	if code, _ := demo.model("clip-b32-text.onnx"); code != 404 {
		t.Fatalf("demo model: %d", code)
	}
	if code, body := bob.model("clip-b32-text.onnx"); code != 200 || body != "clip-b32-text.onnx bytes" {
		t.Fatalf("bob model: %d %q", code, body)
	}
	for i := 0; i < cap(modelSlots); i++ {
		modelSlots <- struct{}{}
	}
	t.Cleanup(func() {
		for len(modelSlots) > 0 {
			<-modelSlots
		}
	})
	if code, _ := bob.model("clip-b32-text.onnx"); code != 503 {
		t.Fatalf("with every slot taken: %d", code)
	}
}

// Requests of a demo account are limited per source; other accounts on the same server (a reviewer's) are not, and
// the budget comes back with time.
func TestDemoRequestsAreLimitedPerSource(t *testing.T) {
	e, admin, demo, _, _ := demoEnv(t)
	now := time.Now()
	e.app.demoReqs.now = func() time.Time { return now }
	for i := 0; i < demoBurst; i++ {
		if code, _ := demo.do("GET", "/api/me", nil, false); code != 200 {
			t.Fatalf("request %d: %d", i, code)
		}
	}
	if code, _ := demo.do("GET", "/api/me", nil, false); code != 429 {
		t.Fatalf("over the budget: %d", code)
	}
	for i := 0; i < demoBurst+50; i++ {
		if code, _ := admin.do("GET", "/api/me", nil, false); code != 200 {
			t.Fatalf("another account is limited: %d", code)
		}
	}
	now = now.Add(2 * time.Second)
	if code, _ := demo.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatalf("after a pause: %d", code)
	}
}

// Sign-ins to the demo are counted per source even when they succeed (the password is published); a reviewer's
// account signs in as often as it likes.
func TestDemoSignInsArePerSourceAndHour(t *testing.T) {
	t.Setenv("DEMO_ACCOUNTS", "demo@x.org")
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	_, db := e.acceptInvite(e.invite(admin, "demo@x.org"))
	_, rv := e.acceptInvite(e.invite(admin, "reviewer@x.org"))
	e.app.trustProxy = true
	login := func(email, ip, auth string) int {
		b, _ := json.Marshal(map[string]string{"email": email, "auth": auth})
		req, _ := http.NewRequest("POST", e.srv.URL+"/api/auth/login", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", ip)
		resp, err := e.srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for i := 0; i < demoSignIns; i++ {
		if code := login("demo@x.org", "198.51.100.7", db["auth"].(string)); code != 200 {
			t.Fatalf("demo sign-in %d: %d", i, code)
		}
	}
	if code := login("demo@x.org", "198.51.100.7", db["auth"].(string)); code != 429 {
		t.Fatalf("over the hour's sign-ins: %d", code)
	}
	if code := login("demo@x.org", "203.0.113.4", db["auth"].(string)); code != 200 {
		t.Fatalf("another visitor: %d", code)
	}
	for i := 0; i < demoSignIns+5; i++ {
		if code := login("reviewer@x.org", "198.51.100.7", rv["auth"].(string)); code != 200 {
			t.Fatalf("reviewer sign-in %d: %d", i, code)
		}
	}
}

// List turns of the demo account are per visitor: a visitor holding every turn of the account (or of another
// group of visitors) doesn't stop the next one.
func TestDemoListTurnsArePerVisitor(t *testing.T) {
	e, _, demo, _, _ := demoEnv(t)
	u, _ := e.app.userByEmail("demo@x.org")
	full := func(key string) {
		c := make(chan struct{}, listPerUser)
		for i := 0; i < listPerUser; i++ {
			c <- struct{}{}
		}
		e.app.listMu.Lock()
		e.app.lists[key] = c
		e.app.listMu.Unlock()
	}
	full(u.ID)
	for i := 0; i < 64; i++ {
		if k := fmt.Sprintf("demo|%d", i); k != demoListKey(t, e) {
			full(k)
		}
	}
	done := make(chan int, 1)
	go func() { code, _ := demo.do("GET", "/api/items", nil, false); done <- code }()
	select {
	case code := <-done:
		if code != 200 {
			t.Fatalf("list: %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the demo visitor waits for turns others hold")
	}
}

// demoListKey: the list group of the test client's source.
func demoListKey(t *testing.T, e *env) string {
	t.Helper()
	h := fnv.New32a()
	h.Write([]byte(limiterIP("127.0.0.1")))
	return fmt.Sprintf("demo|%d", h.Sum32()%64)
}
