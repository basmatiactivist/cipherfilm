package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type env struct {
	t     *testing.T
	app   *App
	srv   *httptest.Server
	setup string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	log.SetOutput(io.Discard)
	app, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.db.Close() })
	// capture the setup token the same way an operator would: it is generated, then only its hash is stored
	if err := app.initSetup(); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewTLSServer(app.handler())
	t.Cleanup(srv.Close)
	return &env{t: t, app: app, srv: srv}
}

// Replace the stored setup token with a known one so tests can use it.
func (e *env) knownSetupToken() string {
	tok := "test-setup-token"
	e.app.db.Exec(`UPDATE setup_state SET token_hash=?`, sha256hex(tok))
	return tok
}

type client struct {
	e    *env
	c    *http.Client
	csrf string
}

func (e *env) client() *client {
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	return &client{e: e, c: c}
}

func (c *client) do(method, path string, body any, csrf bool) (int, map[string]any) {
	c.e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.e.srv.URL+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if csrf && c.csrf != "" {
		req.Header.Set("X-CSRF-Token", c.csrf)
	}
	resp, err := c.c.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	if v, ok := out["csrf"].(string); ok {
		c.csrf = v
	}
	return resp.StatusCode, out
}

func rb(n int) string { return b64.EncodeToString(randBytes(n)) }

func bundle() map[string]any {
	return map[string]any{
		"kdf":  map[string]any{"alg": "argon2id13", "v": 1, "ops": 3, "mem": 64 << 20, "salt": rb(16)},
		"auth": rb(32), "wrapped_master_pw": rb(wrappedLen), "wrapped_master_recovery": rb(wrappedLen),
		"wrapped_privkey": rb(wrappedLen), "pubkey": rb(32), "recovery_verifier": rb(32),
	}
}

func with(m map[string]any, kv ...any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	for i := 0; i < len(kv); i += 2 {
		out[kv[i].(string)] = kv[i+1]
	}
	return out
}

func (e *env) setupAdmin(email string) (*client, map[string]any) {
	e.t.Helper()
	c := e.client()
	b := with(bundle(), "setup_token", e.knownSetupToken(), "email", email)
	code, out := c.do("POST", "/api/setup", b, false)
	if code != 201 {
		e.t.Fatalf("setup: %d %v", code, out)
	}
	return c, b
}

func (e *env) invite(admin *client, email string) string {
	e.t.Helper()
	code, out := admin.do("POST", "/api/admin/invites", map[string]string{"email": email}, true)
	if code != 201 {
		e.t.Fatalf("invite: %d %v", code, out)
	}
	return out["token"].(string)
}

func (e *env) acceptInvite(tok string) (*client, map[string]any) {
	e.t.Helper()
	c := e.client()
	b := bundle()
	code, out := c.do("POST", "/api/invites/"+tok+"/accept", b, false)
	if code != 201 {
		e.t.Fatalf("accept: %d %v", code, out)
	}
	return c, b
}

func TestHealthzAndHeaders(t *testing.T) {
	e := newEnv(t)
	resp, err := e.srv.Client().Get(e.srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(b) != "ok" {
		t.Fatalf("got %d %q", resp.StatusCode, b)
	}
	csp := resp.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "default-src 'none'") || strings.Contains(csp, "unsafe-inline") {
		t.Fatalf("bad CSP: %s", csp)
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing nosniff")
	}
}

func TestSetupFlow(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	if code, out := c.do("GET", "/api/setup/status", nil, false); code != 200 || out["needs_setup"] != true {
		t.Fatalf("status %d %v", code, out)
	}
	e.knownSetupToken()
	if code, _ := c.do("POST", "/api/setup", with(bundle(), "setup_token", "wrong", "email", "a@x.org"), false); code != 403 {
		t.Fatalf("wrong token: %d", code)
	}
	weak := with(bundle(), "setup_token", "test-setup-token", "email", "a@x.org", "kdf", map[string]any{"alg": "argon2id13", "v": 1, "ops": 1, "mem": 1 << 20, "salt": rb(16)})
	if code, _ := c.do("POST", "/api/setup", weak, false); code != 400 {
		t.Fatalf("weak kdf accepted: %d", code)
	}
	admin, _ := e.setupAdmin("Admin@X.org")
	if code, out := admin.do("GET", "/api/me", nil, false); code != 200 || out["user"].(map[string]any)["role"] != "admin" {
		t.Fatalf("me: %d %v", code, out)
	}
	// setup can never run twice
	if code, _ := e.client().do("POST", "/api/setup", with(bundle(), "setup_token", "test-setup-token", "email", "b@x.org"), false); code != 404 {
		t.Fatalf("second setup: %d", code)
	}
	if _, out := c.do("GET", "/api/setup/status", nil, false); out["needs_setup"] != false {
		t.Fatal("setup still offered")
	}
}

func TestLoginAndEnumeration(t *testing.T) {
	e := newEnv(t)
	_, ab := e.setupAdmin("admin@x.org")

	c := e.client()
	code, known := c.do("GET", "/api/auth/params?email=admin@x.org", nil, false)
	code2, unknown := c.do("GET", "/api/auth/params?email=nobody@x.org", nil, false)
	if code != 200 || code2 != 200 {
		t.Fatal("params status")
	}
	if len(known) != len(unknown) || unknown["alg"] != "argon2id13" || unknown["salt"] == nil {
		t.Fatalf("shapes differ: %v vs %v", known, unknown)
	}
	// fake salt is stable
	_, again := c.do("GET", "/api/auth/params?email=nobody@x.org", nil, false)
	if again["salt"] != unknown["salt"] {
		t.Fatal("fake salt not deterministic")
	}

	badCode, badOut := c.do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": rb(32)}, false)
	unkCode, unkOut := c.do("POST", "/api/auth/login", map[string]string{"email": "nobody@x.org", "auth": rb(32)}, false)
	if badCode != 401 || unkCode != 401 || badOut["error"] != unkOut["error"] {
		t.Fatalf("login errors differ: %d %v / %d %v", badCode, badOut, unkCode, unkOut)
	}
	code, out := c.do("POST", "/api/auth/login", map[string]string{"email": " ADMIN@x.org ", "auth": ab["auth"].(string)}, false)
	if code != 200 || out["wrapped_master_pw"] != ab["wrapped_master_pw"] {
		t.Fatalf("login: %d %v", code, out)
	}
	if _, has := out["wrapped_master_recovery"]; has {
		t.Fatal("recovery wrap must not be sent at login")
	}
}

func TestLoginRateLimit(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	c := e.client()
	last := 0
	for i := 0; i < 12; i++ {
		last, _ = c.do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": rb(32)}, false)
	}
	if last != 429 {
		t.Fatalf("expected 429, got %d", last)
	}
}

func TestCSRFAndSessionRules(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	if code, _ := admin.do("POST", "/api/admin/invites", map[string]string{"email": "u@x.org"}, false); code != 403 {
		t.Fatalf("missing csrf: %d", code)
	}
	// foreign Origin is blocked
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/auth/logout", strings.NewReader("{}"))
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", admin.csrf)
	resp, _ := admin.c.Do(req)
	if resp.StatusCode != 403 {
		t.Fatalf("cross-origin: %d", resp.StatusCode)
	}
	// non-JSON content type is refused
	req, _ = http.NewRequest("POST", e.srv.URL+"/api/auth/logout", strings.NewReader("x=1"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-CSRF-Token", admin.csrf)
	resp, _ = admin.c.Do(req)
	if resp.StatusCode != 415 {
		t.Fatalf("form post: %d", resp.StatusCode)
	}
	if code, _ := admin.do("POST", "/api/auth/logout", nil, true); code != 200 {
		t.Fatalf("logout: %d", code)
	}
	if code, _ := admin.do("GET", "/api/me", nil, false); code != 401 {
		t.Fatalf("session survived logout: %d", code)
	}
}

func TestSessionExpiry(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	// used: the session moves forward (a day later, again a day later...)
	for d := 1; d <= 3; d++ {
		days := d
		e.app.now = func() time.Time { return time.Now().Add(time.Duration(days) * 24 * time.Hour) }
		if code, _ := admin.do("GET", "/api/me", nil, false); code != 200 {
			t.Fatalf("session used daily ended on day %d: %d", d, code)
		}
	}
	e.app.now = func() time.Time { return time.Now().Add(34 * 24 * time.Hour) }
	if code, _ := admin.do("GET", "/api/me", nil, false); code != 401 {
		t.Fatalf("idle session still valid: %d", code)
	}
}

func TestInviteFlowAndAccessControl(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	tok := e.invite(admin, "Bob@X.org")

	c := e.client()
	if code, out := c.do("GET", "/api/invites/"+tok, nil, false); code != 200 || out["email"] != "bob@x.org" {
		t.Fatalf("invite info: %d %v", code, out)
	}
	if code, _ := c.do("GET", "/api/invites/garbage", nil, false); code != 404 {
		t.Fatal("garbage invite")
	}
	bob, bb := e.acceptInvite(tok)
	// one-time
	if code, _ := e.client().do("POST", "/api/invites/"+tok+"/accept", bundle(), false); code != 404 {
		t.Fatalf("invite reuse: %d", code)
	}
	// bob is a regular user and cannot reach admin APIs (404, not 403)
	for _, p := range [][2]string{{"GET", "/api/admin/users"}, {"POST", "/api/admin/invites"}} {
		if code, _ := bob.do(p[0], p[1], map[string]string{"email": "z@x.org"}, true); code != 404 {
			t.Fatalf("%s %s: %d", p[0], p[1], code)
		}
	}
	// duplicate e-mail cannot be invited
	if code, _ := admin.do("POST", "/api/admin/invites", map[string]string{"email": "bob@x.org"}, true); code != 409 {
		t.Fatalf("dup invite: %d", code)
	}
	// expired invite
	tok2 := e.invite(admin, "carol@x.org")
	e.app.now = func() time.Time { return time.Now().Add(8 * 24 * time.Hour) }
	if code, _ := e.client().do("POST", "/api/invites/"+tok2+"/accept", bundle(), false); code != 404 {
		t.Fatalf("expired invite: %d", code)
	}
	e.app.now = time.Now

	// login works for bob
	if code, _ := e.client().do("POST", "/api/auth/login", map[string]string{"email": "bob@x.org", "auth": bb["auth"].(string)}, false); code != 200 {
		t.Fatalf("bob login: %d", code)
	}
}

func TestAdminUserManagement(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	_, list := admin.do("GET", "/api/admin/users", nil, false)
	users := list["users"].([]any)
	if len(users) != 2 {
		t.Fatalf("users: %v", users)
	}
	var bobID, adminID string
	for _, u := range users {
		m := u.(map[string]any)
		if m["email"] == "bob@x.org" {
			bobID = m["id"].(string)
		} else {
			adminID = m["id"].(string)
		}
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+adminID, map[string]string{"status": "disabled"}, true); code != 400 {
		t.Fatalf("self-disable: %d", code)
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+bobID, map[string]string{"status": "disabled"}, true); code != 200 {
		t.Fatalf("disable: %d", code)
	}
	if code, _ := bob.do("GET", "/api/me", nil, false); code != 401 {
		t.Fatalf("disabled user kept session: %d", code)
	}
	if code, _ := e.client().do("POST", "/api/auth/login", map[string]string{"email": "bob@x.org", "auth": bb["auth"].(string)}, false); code != 401 {
		t.Fatalf("disabled login: %d", code)
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+bobID, map[string]string{"status": "active"}, true); code != 200 {
		t.Fatal("re-enable")
	}
	if code, _ := admin.do("DELETE", "/api/admin/users/"+adminID, nil, true); code != 400 {
		t.Fatal("self-delete")
	}
	if code, _ := admin.do("DELETE", "/api/admin/users/"+bobID, nil, true); code != 200 {
		t.Fatal("delete")
	}
	if code, _ := e.client().do("POST", "/api/auth/login", map[string]string{"email": "bob@x.org", "auth": bb["auth"].(string)}, false); code != 401 {
		t.Fatal("deleted user can log in")
	}
}

func TestPasswordChange(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	other := e.client()
	other.do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": ab["auth"].(string)}, false)

	nb := bundle()
	body := map[string]any{"current_auth": rb(32), "new_auth": nb["auth"], "new_kdf": nb["kdf"], "new_wrapped_master_pw": nb["wrapped_master_pw"]}
	if code, _ := admin.do("POST", "/api/auth/password", body, true); code != 403 {
		t.Fatalf("wrong current password accepted: %d", code)
	}
	body["current_auth"] = ab["auth"]
	if code, out := admin.do("POST", "/api/auth/password", body, true); code != 200 {
		t.Fatalf("change: %d %v", code, out)
	}
	if code, _ := other.do("GET", "/api/me", nil, false); code != 401 {
		t.Fatal("other session survived password change")
	}
	if code, _ := admin.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatal("current session should survive")
	}
	c := e.client()
	if code, _ := c.do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": ab["auth"].(string)}, false); code != 401 {
		t.Fatal("old password still works")
	}
	if code, out := c.do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": nb["auth"].(string)}, false); code != 200 || out["wrapped_master_pw"] != nb["wrapped_master_pw"] {
		t.Fatalf("new password: %d", code)
	}
}

func TestRecovery(t *testing.T) {
	e := newEnv(t)
	_, ab := e.setupAdmin("admin@x.org")
	c := e.client()

	if code, _ := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": rb(32)}, false); code != 401 {
		t.Fatal("bad recovery proof accepted")
	}
	if code, _ := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "nobody@x.org", "recovery_auth": rb(32)}, false); code != 401 {
		t.Fatal("unknown email")
	}
	code, out := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": ab["recovery_verifier"].(string)}, false)
	if code != 200 || out["wrapped_master_recovery"] != ab["wrapped_master_recovery"] {
		t.Fatalf("start: %d %v", code, out)
	}
	ticket := out["ticket"].(string)
	nb := bundle()
	fin := map[string]any{"ticket": ticket, "new_auth": nb["auth"], "new_kdf": nb["kdf"], "new_wrapped_master_pw": nb["wrapped_master_pw"],
		"new_wrapped_master_recovery": nb["wrapped_master_recovery"], "new_recovery_verifier": nb["recovery_verifier"]}
	if code, out := c.do("POST", "/api/auth/recover/finish", fin, false); code != 200 {
		t.Fatalf("finish: %d %v", code, out)
	}
	// ticket is single-use
	if code, _ := c.do("POST", "/api/auth/recover/finish", fin, false); code != 403 {
		t.Fatalf("ticket reuse: %d", code)
	}
	if code, _ := e.client().do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": ab["auth"].(string)}, false); code != 401 {
		t.Fatal("old password works after recovery")
	}
	if code, _ := e.client().do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": nb["auth"].(string)}, false); code != 200 {
		t.Fatal("new password fails after recovery")
	}
	// old recovery key is dead, new one works
	if code, _ := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": ab["recovery_verifier"].(string)}, false); code != 401 {
		t.Fatal("old recovery key still valid")
	}
	if code, _ := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": nb["recovery_verifier"].(string)}, false); code != 200 {
		t.Fatal("new recovery key rejected")
	}
}

func TestServerStoresNoPlainSecrets(t *testing.T) {
	e := newEnv(t)
	_, ab := e.setupAdmin("admin@x.org")
	var authHash, recHash string
	e.app.db.QueryRow(`SELECT auth_hash, recovery_hash FROM users`).Scan(&authHash, &recHash)
	if strings.Contains(authHash, ab["auth"].(string)) || strings.Contains(recHash, ab["recovery_verifier"].(string)) {
		t.Fatal("auth material stored in the clear")
	}
	if !verifySecret(authHash, ab["auth"].(string)) {
		t.Fatal("hash does not verify")
	}
}

func TestHeicWorkerCSPIsIsolated(t *testing.T) {
	e := newEnv(t)
	get := func(path string) string {
		resp, err := e.srv.Client().Get(e.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.Header.Get("Content-Security-Policy")
	}
	if p := get("/heic/worker.js"); !strings.Contains(p, "'unsafe-eval'") || !strings.Contains(p, "connect-src 'none'") || !strings.Contains(p, "worker-src 'none'") {
		t.Fatalf("heic worker CSP: %s", p)
	}
	for _, path := range []string{"/", "/assets/index.js", "/api/me", "/workers/kdf.js"} {
		if p := get(path); strings.Contains(p, "'unsafe-eval'") {
			t.Fatalf("unsafe-eval leaked to %s: %s", path, p)
		}
	}
}

func TestServiceWorkerPaths(t *testing.T) {
	e := newEnv(t)
	resp, err := e.srv.Client().Get(e.srv.URL + "/sw/stream/0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("/sw/stream must never be served by the server: %d", resp.StatusCode)
	}
}

func TestLimiterIsAtomicUnderConcurrency(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	e.app.trustProxy = true
	var wg sync.WaitGroup
	codes := make([]int, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			b, _ := json.Marshal(map[string]string{"email": "admin@x.org", "auth": rb(32)})
			req, _ := http.NewRequest("POST", e.srv.URL+"/api/auth/login", bytes.NewReader(b))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Forwarded-For", "203.0.113.7") // one source
			resp, err := e.srv.Client().Do(req)
			if err != nil {
				return
			}
			resp.Body.Close()
			codes[i] = resp.StatusCode
		}(i)
	}
	wg.Wait()
	verified := 0
	for _, c := range codes {
		if c == 401 {
			verified++
		}
	}
	if verified > 10 {
		t.Fatalf("%d concurrent wrong logins were verified against a limit of 10: %v", verified, codes)
	}
}

func TestStrangerCannotLockOutTheRealUser(t *testing.T) {
	e := newEnv(t)
	_, ab := e.setupAdmin("admin@x.org")
	e.app.trustProxy = true
	login := func(ip, email, auth string) int {
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
	// an attacker at one address burns its own budget for the victim's e-mail ...
	for i := 0; i < 12; i++ {
		login("198.51.100.1", "admin@x.org", rb(32))
	}
	if code := login("198.51.100.1", "admin@x.org", rb(32)); code != 429 {
		t.Fatalf("attacker is not throttled: %d", code)
	}
	// ... but the real user, from another address, can still sign in
	if code := login("203.0.113.9", "admin@x.org", ab["auth"].(string)); code != 200 {
		t.Fatalf("real user locked out by a stranger: %d", code)
	}
}

func TestRecoveryTicketsDieWhenCredentialsChange(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	c := e.client()
	_, out := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": ab["recovery_verifier"].(string)}, false)
	ticket, _ := out["ticket"].(string)
	if ticket == "" {
		t.Fatal("no ticket")
	}
	nk := bundle()
	if code, _ := admin.do("POST", "/api/auth/recovery-key", map[string]any{"current_auth": ab["auth"], "wrapped_master_recovery": nk["wrapped_master_recovery"], "recovery_verifier": nk["recovery_verifier"]}, true); code != 200 {
		t.Fatal("rotate")
	}
	fin := map[string]any{"ticket": ticket, "new_auth": nk["auth"], "new_kdf": nk["kdf"], "new_wrapped_master_pw": nk["wrapped_master_pw"], "new_wrapped_master_recovery": nk["wrapped_master_recovery"], "new_recovery_verifier": nk["recovery_verifier"]}
	if code, _ := c.do("POST", "/api/auth/recover/finish", fin, false); code != 403 {
		t.Fatalf("ticket survived a recovery-key rotation: %d", code)
	}
}

// Behind one shared proxy address every client has the same source. A stranger who exhausts the per-source buckets
// must not lock out a browser that has signed in before, but must still be stopped himself.
func TestKnownDeviceIsNotLockedOutByStrangers(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	login := map[string]string{"email": "admin@x.org", "auth": ab["auth"].(string)}
	stranger := e.client()
	for i := 0; i < 40; i++ {
		stranger.do("POST", "/api/auth/login", map[string]string{"email": "admin@x.org", "auth": rb(32)}, false)
	}
	if code, _ := stranger.do("POST", "/api/auth/login", login, false); code != 429 {
		t.Fatalf("an unknown browser should be blocked after the burst, got %d", code)
	}
	if code, _ := admin.do("POST", "/api/auth/login", login, false); code != 200 {
		t.Fatalf("the known device was locked out: %d", code)
	}
	// a forged cookie gets no special treatment
	forged := e.client()
	u, _ := e.app.userByEmail("admin@x.org")
	forged.c.Jar.SetCookies(mustURL(e.srv.URL), []*http.Cookie{{Name: deviceCookie, Value: u.ID + ".deadbeef", Path: "/"}})
	if code, _ := forged.do("POST", "/api/auth/login", login, false); code != 429 {
		t.Fatalf("forged device cookie should not bypass the limit: %d", code)
	}
}

// The same for recovery: strangers using up the shared source's recovery attempts must not block a known browser.
func TestKnownDeviceCanRecoverDespiteStrangers(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	rec := map[string]string{"email": "admin@x.org", "recovery_auth": ab["recovery_verifier"].(string)}
	stranger := e.client()
	for i := 0; i < 40; i++ {
		stranger.do("POST", "/api/auth/recover/start", map[string]string{"email": fmt.Sprintf("nobody%d@x.org", i), "recovery_auth": rb(32)}, false)
	}
	if code, _ := stranger.do("POST", "/api/auth/recover/start", rec, false); code != 429 {
		t.Fatalf("an unknown browser should be blocked after the burst, got %d", code)
	}
	if code, _ := admin.do("POST", "/api/auth/recover/start", rec, false); code != 200 {
		t.Fatalf("the known device could not recover: %d", code)
	}
}

func mustURL(s string) *url.URL { u, _ := url.Parse(s); return u }

func TestLimiterIPAndClientIPEdgeCases(t *testing.T) {
	if limiterIP("::ffff:1.2.3.4") != limiterIP("1.2.3.4") {
		t.Fatal("IPv4-mapped and plain forms must share a bucket")
	}
	if limiterIP("2001:db8:1:2:aaaa::1") != limiterIP("2001:db8:1:2:bbbb::2") {
		t.Fatal("addresses in one /64 must share a bucket")
	}
	a := &App{trustProxy: true}
	r, _ := http.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Add("X-Forwarded-For", "6.6.6.6")          // client-supplied line
	r.Header.Add("X-Forwarded-For", "7.7.7.7, 8.8.8.8") // line added by the trusted proxy
	if got := a.clientIP(r); got != "8.8.8.8" {
		t.Fatalf("clientIP = %q, want the proxy's own entry", got)
	}
}
