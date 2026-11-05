package main

import (
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
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
