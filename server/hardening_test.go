package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoginSessionNeedsTheCheckedPasswordStillCurrent(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	u, _ := e.app.userByEmail("admin@x.org")
	// the password changed while this login's check ran: u.AuthHash is the old one
	e.app.db.Exec(`UPDATE users SET auth_hash='changed' WHERE id=?`, u.ID)
	if _, err := e.app.startSession(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/auth/login", nil), u.ID, u.AuthHash); err != errCredentialsChanged {
		t.Fatalf("session started with a password that is no longer the account's: %v", err)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id=?`, u.ID).Scan(&n)
	if n != 1 { // only the one from setup
		t.Fatalf("%d sessions", n)
	}
}

func TestOnlyThePublicHostIsServed(t *testing.T) {
	e := newEnv(t)
	e.app.hosts = publicHosts("photos.example.org, other.example.org")
	h := e.app.handler()
	for host, want := range map[string]int{"photos.example.org": 200, "PHOTOS.example.org:443": 200, "other.example.org": 200, "rebind.attacker.test": 421, "127.0.0.1:8080": 421} {
		req := httptest.NewRequest("GET", "/api/setup/status", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("%s: %d, want %d", host, rec.Code, want)
		}
	}
	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Host = "127.0.0.1:8080"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("healthz: %d", rec.Code)
	}
}

// slowBody sends a little, then stalls.
type slowBody struct{ sent bool }

func (b *slowBody) Read(p []byte) (int, error) {
	if !b.sent {
		b.sent = true
		return copy(p, `{"email":`), nil
	}
	time.Sleep(time.Hour)
	return 0, io.EOF
}

func TestStalledRequestBodyIsCutOff(t *testing.T) {
	old := jsonReadTime
	jsonReadTime = 300 * time.Millisecond
	defer func() { jsonReadTime = old }()
	e := newEnv(t)
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/auth/login", &slowBody{})
	req.ContentLength = 1000
	req.Header.Set("Content-Type", "application/json")
	c := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	start := time.Now()
	resp, err := c.Do(req)
	if err == nil {
		resp.Body.Close()
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("the handler waited %v for a stalled body (%v)", d, fmt.Sprint(err))
	}
}

func TestStalledBodyOfARefusedRequestIsCutOff(t *testing.T) {
	old := jsonReadTime
	jsonReadTime = 300 * time.Millisecond
	defer func() { jsonReadTime = old }()
	e := newEnv(t)
	// not signed in: the server answers 401 without reading the body, then drains what is left of it
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/items", &slowBody{})
	req.ContentLength = 1 << 20
	req.Header.Set("Content-Type", "application/json")
	c := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	start := time.Now()
	if resp, err := c.Do(req); err == nil {
		resp.Body.Close()
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("a refused request held its connection for %v", d)
	}
}

// The setup token mints an admin only while there is no account: one made on the console first ends the setup.
func TestSetupEndsOnceAnAccountExists(t *testing.T) {
	e := newEnv(t)
	tok := e.knownSetupToken()
	var kb keyBundle
	raw, _ := json.Marshal(bundle())
	json.Unmarshal(raw, &kb)
	tx, _ := e.app.db.Begin()
	if _, err := insertUser(context.Background(), tx, "first@x.org", "admin", 0, kb, e.app.now()); err != nil {
		t.Fatal(err)
	}
	tx.Commit()
	if code, _ := e.client().do("POST", "/api/setup", with(bundle(), "setup_token", tok, "email", "late@x.org"), false); code == 200 || code == 201 {
		t.Fatalf("setup after an account exists: %d", code)
	}
}

// A malformed finish does not use up the recovery ticket.
func TestMalformedRecoveryFinishKeepsTheTicket(t *testing.T) {
	e := newEnv(t)
	_, ab := e.setupAdmin("admin@x.org")
	c := e.client()
	_, out := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": ab["recovery_verifier"].(string)}, false)
	nb := bundle()
	fin := map[string]any{"ticket": out["ticket"], "new_auth": nb["auth"], "new_kdf": nb["kdf"], "new_wrapped_master_pw": nb["wrapped_master_pw"],
		"new_wrapped_master_recovery": nb["wrapped_master_recovery"], "new_recovery_verifier": "short"}
	if code, _ := c.do("POST", "/api/auth/recover/finish", fin, false); code != 400 {
		t.Fatalf("malformed finish: %d", code)
	}
	fin["new_recovery_verifier"] = nb["recovery_verifier"]
	if code, out := c.do("POST", "/api/auth/recover/finish", fin, false); code != 200 {
		t.Fatalf("finish after a malformed one: %d %v", code, out)
	}
}

// Signing in again in a browser ends the session it had, instead of leaving it valid without its cookie.
func TestSignInAgainEndsThePreviousSession(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	before := len(sessionList(t, admin))
	admin.do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": ab["auth"].(string)}, false)
	if after := len(sessionList(t, admin)); after != before {
		t.Fatalf("sessions: %d before, %d after signing in again", before, after)
	}
}

// An expired session does not keep the indexer role.
func TestExpiredSessionIsNoIndexer(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	phone := e.login("admin@x.org", ab)
	i1 := e.readyItem(admin)
	put := func(c *client) int {
		code, _ := c.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(200), "model": "laionb32/1"}, true)
		return code
	}
	if put(phone) != 200 || put(admin) != 409 {
		t.Fatal("phone should be the indexer")
	}
	u, _ := e.app.userByEmail("admin@x.org")
	e.app.db.Exec(`UPDATE sessions SET expires_at=? WHERE pub=?`, e.app.now().Add(-time.Hour).Unix(), u.Indexer)
	if code := put(admin); code != 200 {
		t.Fatalf("an expired session kept the indexer role: %d", code)
	}
}

// Half-written files a crash left behind are removed at startup; files of uploads running now are not.
func TestCrashLeftoversAreSweptAtStart(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	id := e.readyItem(admin)
	old, fresh := filepath.Join(e.app.itemDir(id), ".tmp-1"), filepath.Join(e.app.itemDir(id), ".tmp-2")
	os.WriteFile(old, []byte("x"), 0o600)
	os.WriteFile(fresh, []byte("x"), 0o600)
	started := time.Now()
	os.Chtimes(old, started.Add(-time.Hour), started.Add(-time.Hour))
	os.Chtimes(fresh, started.Add(time.Second), started.Add(time.Second))
	e.app.sweepTemps(started)
	if _, err := os.Stat(old); err == nil {
		t.Fatal("a crash leftover was kept")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("a file of a running upload was removed")
	}
}

// The last-administrator rule is part of the UPDATE or DELETE itself.
func TestLastAdminRuleHoldsInTheDatabase(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	u, _ := e.app.userByEmail("admin@x.org")
	res, err := e.app.db.Exec(`UPDATE users SET status='disabled' WHERE id=? AND `+keepsAdmin, u.ID)
	if rowsAffected(res, err) != 0 {
		t.Fatal("the only active administrator was disabled")
	}
	res, err = e.app.db.Exec(`DELETE FROM users WHERE id=? AND `+keepsAdmin, u.ID)
	if rowsAffected(res, err) != 0 {
		t.Fatal("the only active administrator was deleted")
	}
}

// A forwarded address that is not an address does not become a limiter key of its own.
func TestForwardedForMustBeAnAddress(t *testing.T) {
	a := &App{trustProxy: true}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:1"
	r.Header.Set("X-Forwarded-For", "anything-goes-1")
	if got := a.clientIP(r); got != "127.0.0.1" {
		t.Fatalf("clientIP = %q", got)
	}
}

// With many sources the limiter sweeps expired entries at most once a minute, not on every request.
func TestLimiterSweepsAtMostOnceAMinute(t *testing.T) {
	now := time.Now()
	l := newLimiter(time.Second, 10)
	l.now = func() time.Time { return now }
	fill := func(from int) {
		for i := from; i < from+10001; i++ {
			l.m[fmt.Sprint(i)] = &entry{count: 1, reset: now.Add(-time.Second)}
		}
	}
	fill(0)
	l.take("a")
	if len(l.m) != 1 {
		t.Fatalf("not swept: %d", len(l.m))
	}
	fill(20000)
	l.take("b")
	if len(l.m) < 10000 {
		t.Fatal("swept again within the minute")
	}
	now = now.Add(time.Minute)
	l.take("c")
	if len(l.m) > 3 {
		t.Fatalf("not swept after a minute: %d", len(l.m))
	}
}

// The HEIC policy (which allows eval) goes only to files under /heic/ after the path is resolved; frames are refused.
func TestHeicPolicyOnlyForHeicFiles(t *testing.T) {
	e := newEnv(t)
	for _, p := range []string{"/heic/..%2findex.html", "/heic/..%2fsw.js", "/"} {
		req, _ := http.NewRequest("GET", e.srv.URL+p, nil)
		resp, err := e.srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.Header.Get("Content-Security-Policy") != csp {
			t.Fatalf("%s: %q", p, resp.Header.Get("Content-Security-Policy"))
		}
		if resp.Header.Get("X-Frame-Options") != "DENY" {
			t.Fatalf("%s: no X-Frame-Options", p)
		}
	}
}
