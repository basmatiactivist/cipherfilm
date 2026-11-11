package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// RFC 6238, appendix B (SHA-1 seed), cut to 6 digits.
func TestTOTPVectors(t *testing.T) {
	seed := []byte("12345678901234567890")
	for _, v := range []struct {
		at   int64
		code string
	}{{59, "287082"}, {1111111109, "081804"}, {1111111111, "050471"}, {1234567890, "005924"}, {2000000000, "279037"}, {20000000000, "353130"}} {
		if got := hotp(seed, uint64(v.at/30)); got != v.code {
			t.Errorf("T=%d: %s, want %s", v.at, got, v.code)
		}
		step, ok := totpMatch(seed, v.code, time.Unix(v.at, 0))
		if !ok || step != v.at/30 {
			t.Errorf("T=%d: match %v %d", v.at, ok, step)
		}
	}
	// one step before and after counts, two don't
	at := time.Unix(1111111109, 0)
	if _, ok := totpMatch(seed, "081804", at.Add(30*time.Second)); !ok {
		t.Error("previous step refused")
	}
	if _, ok := totpMatch(seed, "081804", at.Add(-30*time.Second)); !ok {
		t.Error("next step refused")
	}
	if _, ok := totpMatch(seed, "081804", at.Add(61*time.Second)); ok {
		t.Error("two steps late accepted")
	}
	for _, bad := range []string{"", "08180", "0818045", "08180a", " 081804"} {
		if _, ok := totpMatch(seed, bad, at); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestRecoveryCodeFormat(t *testing.T) {
	codes := newRecoveryCodes()
	seen := map[string]bool{}
	for _, c := range codes {
		if len(c) != 19 || strings.Count(c, "-") != 3 {
			t.Fatalf("format %q", c)
		}
		n, ok := normRecoveryCode(c)
		if !ok || seen[n] {
			t.Fatalf("norm %q", c)
		}
		seen[n] = true
		// typed loosely: upper case, no dashes, spaces
		if n2, ok := normRecoveryCode(" " + strings.ToUpper(strings.ReplaceAll(c, "-", " ")) + " "); !ok || n2 != n {
			t.Fatalf("loose %q", c)
		}
	}
	if len(codes) != 10 {
		t.Fatal(len(codes))
	}
	if n, ok := normRecoveryCode("O0IL-0000-0000-0000"); !ok || n != "0011000000000000" {
		t.Fatalf("confusables: %q %v", n, ok)
	}
	if _, ok := normRecoveryCode("uuuu-0000-0000-0000"); ok {
		t.Fatal("u is not in the alphabet")
	}
}

// ---- helpers ----

// clock pins the server's time, so codes can be made for it; tick moves it on.
type clock struct{ at time.Time }

func (e *env) pinClock() *clock {
	c := &clock{at: time.Now().Truncate(30 * time.Second).Add(5 * time.Second)}
	e.app.now = func() time.Time { return c.at }
	return c
}

func (c *clock) tick(d time.Duration) { c.at = c.at.Add(d) }

func codeAt(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	b, err := b32Secret.DecodeString(secret)
	if err != nil {
		t.Fatal(err)
	}
	return hotp(b, uint64(at.Unix()/30))
}

// enable2FA turns two-step sign-in on for a signed-in client; returns the secret and the recovery codes.
func (e *env) enable2FA(c *client, b map[string]any) (string, []string) {
	e.t.Helper()
	code, out := c.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": b["auth"]}, true)
	if code != 200 {
		e.t.Fatalf("setup: %d %v", code, out)
	}
	secret := out["secret"].(string)
	code, out = c.do("POST", "/api/me/2fa/enable", map[string]any{"code": codeAt(e.t, secret, e.app.now())}, true)
	if code != 200 {
		e.t.Fatalf("enable: %d %v", code, out)
	}
	var rc []string
	for _, x := range out["recovery_codes"].([]any) {
		rc = append(rc, x.(string))
	}
	return secret, rc
}

type rawResp struct {
	code   int
	body   map[string]any
	header http.Header
}

// post sends a JSON request without the client's CSRF bookkeeping, keeping the headers of the answer.
func (c *client) post(path string, body any) rawResp {
	c.e.t.Helper()
	bb, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", c.e.srv.URL+path, bytes.NewReader(bb))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CF-Device", "Test phone (Android app)")
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
	return rawResp{resp.StatusCode, out, resp.Header}
}

// passwordStep signs in with the password of an account with two-step sign-in; returns the pending token.
func (e *env) passwordStep(c *client, email string, b map[string]any) string {
	e.t.Helper()
	r := c.post("/api/auth/login", map[string]any{"email": email, "auth": b["auth"]})
	if r.code != 401 || r.body["code"] != twoFactorRequired {
		e.t.Fatalf("password step: %d %v", r.code, r.body)
	}
	return r.body["pending"].(string)
}

// ---- the flows ----

func TestTwoFactorSetupNeedsPasswordAndACode(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	if code, out := admin.do("GET", "/api/me/2fa", nil, false); code != 200 || out["enabled"] != false || out["available"] != true {
		t.Fatalf("status: %d %v", code, out)
	}
	if code, _ := admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": rb(32)}, true); code != 403 {
		t.Fatalf("wrong password: %d", code)
	}
	if code, _ := admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"]}, false); code != 403 {
		t.Fatalf("without csrf: %d", code)
	}
	if code, _ := admin.do("POST", "/api/me/2fa/enable", map[string]any{"code": "123456"}, true); code != 409 {
		t.Fatalf("enable before setup: %d", code)
	}
	code, out := admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"]}, true)
	if code != 200 {
		t.Fatalf("setup: %d %v", code, out)
	}
	secret := out["secret"].(string)
	uri := out["uri"].(string)
	if len(secret) != 32 || !strings.HasPrefix(uri, "otpauth://totp/Cipherfilm:admin@x.org?") || !strings.Contains(uri, "secret="+secret) ||
		!strings.Contains(uri, "issuer=Cipherfilm") || !strings.Contains(uri, "digits=6") || !strings.Contains(uri, "period=30") || !strings.Contains(uri, "algorithm=SHA1") {
		t.Fatalf("secret %q uri %q", secret, uri)
	}
	// not on until confirmed: the password alone still signs in
	e.login("admin@x.org", ab)
	// the secret is stored encrypted, bound to the account
	u, _ := e.app.userByEmail("admin@x.org")
	if u.TOTPPending == "" || strings.Contains(u.TOTPPending, secret) {
		t.Fatalf("pending stored as %q", u.TOTPPending)
	}
	if _, err := e.app.openTOTP("someone-else", "pending", u.TOTPPending); err == nil {
		t.Fatal("opened for another account")
	}
	if _, err := e.app.openTOTP(u.ID, "on", u.TOTPPending); err == nil {
		t.Fatal("pending secret opened as the active one")
	}
	if code, out := admin.do("POST", "/api/me/2fa/enable", map[string]any{"code": "000000"}, true); code != 403 || out["code"] != "wrong_code" {
		t.Fatalf("wrong code: %d %v", code, out)
	}
	code, out = admin.do("POST", "/api/me/2fa/enable", map[string]any{"code": codeAt(t, secret, clk.at)}, true)
	if code != 200 {
		t.Fatalf("enable: %d %v", code, out)
	}
	if n := len(out["recovery_codes"].([]any)); n != 10 {
		t.Fatalf("%d recovery codes", n)
	}
	if code, out := admin.do("GET", "/api/me", nil, false); code != 200 || out["two_factor"] != true {
		t.Fatalf("me: %v", out)
	}
	if _, out := admin.do("GET", "/api/me/2fa", nil, false); out["enabled"] != true || out["recovery_codes_left"].(float64) != 10 {
		t.Fatalf("status: %v", out)
	}
	// only hashes of the recovery codes are stored
	var stored string
	e.app.db.QueryRow(`SELECT group_concat(code_hash) FROM recovery_codes`).Scan(&stored)
	for _, c := range out["recovery_codes"].([]any) {
		n, _ := normRecoveryCode(c.(string))
		if strings.Contains(stored, n) {
			t.Fatal("a recovery code stored as it is")
		}
	}
	u, _ = e.app.userByEmail("admin@x.org")
	if u.TOTPPending != "" || u.TOTPSecret == "" || strings.Contains(u.TOTPSecret, secret) {
		t.Fatalf("stored: %+v", u)
	}
	if code, _ := admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"]}, true); code != 409 {
		t.Fatalf("setup while on: %d", code)
	}
}

func TestTwoFactorSignInGivesNothingBeforeTheCode(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	secret, _ := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second) // the code used to turn it on is spent

	c := e.client()
	r := c.post("/api/auth/login", map[string]any{"email": "admin@x.org", "auth": ab["auth"]})
	if r.code != 401 || r.body["code"] != twoFactorRequired || r.body["pending"] == nil || r.body["expires_in"].(float64) != 300 {
		t.Fatalf("password step: %d %v", r.code, r.body)
	}
	// no session, no cookie, none of the account's keys or anything else of it
	if len(r.header.Values("Set-Cookie")) != 0 {
		t.Fatalf("cookies before the code: %v", r.header.Values("Set-Cookie"))
	}
	for k := range r.body {
		if k != "error" && k != "code" && k != "pending" && k != "expires_in" {
			t.Fatalf("password step answered %q", k)
		}
	}
	if code, _ := c.do("GET", "/api/me", nil, false); code != 401 {
		t.Fatalf("signed in without the code: %d", code)
	}
	pending := r.body["pending"].(string)
	// wrong code: refused, no session
	r = c.post("/api/auth/login/2fa", map[string]any{"pending": pending, "code": "000000"})
	if r.code != 401 || r.body["code"] != "wrong_code" || len(r.header.Values("Set-Cookie")) != 0 {
		t.Fatalf("wrong code: %d %v", r.code, r.body)
	}
	good := codeAt(t, secret, clk.at)
	r = c.post("/api/auth/login/2fa", map[string]any{"pending": pending, "code": good})
	if r.code != 200 || r.body["wrapped_master_pw"] != ab["wrapped_master_pw"] || r.body["csrf"] == nil {
		t.Fatalf("second step: %d %v", r.code, r.body)
	}
	if code, _ := c.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatalf("not signed in after the code: %d", code)
	}
	// the token was single use
	r = e.client().post("/api/auth/login/2fa", map[string]any{"pending": pending, "code": good})
	if r.code != 401 || r.body["code"] != "two_factor_expired" {
		t.Fatalf("token reused: %d %v", r.code, r.body)
	}
	// the same code on a new sign-in: refused (replay), also a minute later while it would still be in the window
	c2 := e.client()
	p2 := e.passwordStep(c2, "admin@x.org", ab)
	if r := c2.post("/api/auth/login/2fa", map[string]any{"pending": p2, "code": good}); r.code != 401 || r.body["code"] != "wrong_code" {
		t.Fatalf("replayed code: %d %v", r.code, r.body)
	}
	// an older code of the window is refused too: only codes after the last one used count
	if r := c2.post("/api/auth/login/2fa", map[string]any{"pending": p2, "code": codeAt(t, secret, clk.at.Add(-30*time.Second))}); r.code != 401 {
		t.Fatalf("older code: %d %v", r.code, r.body)
	}
	clk.tick(30 * time.Second)
	if r := c2.post("/api/auth/login/2fa", map[string]any{"pending": p2, "code": codeAt(t, secret, clk.at)}); r.code != 200 {
		t.Fatalf("next code: %d %v", r.code, r.body)
	}
	// the code step can't be skipped with a made-up token
	if r := e.client().post("/api/auth/login/2fa", map[string]any{"pending": rb(32), "code": codeAt(t, secret, clk.at)}); r.code != 401 {
		t.Fatalf("made-up token: %d", r.code)
	}
	// a wrong password never gets to the code step
	if r := e.client().post("/api/auth/login", map[string]any{"email": "admin@x.org", "auth": rb(32)}); r.code != 401 || r.body["pending"] != nil {
		t.Fatalf("wrong password: %d %v", r.code, r.body)
	}
}

func TestPendingSignInExpiresAndWearsOut(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	secret, _ := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)

	c := e.client()
	p := e.passwordStep(c, "admin@x.org", ab)
	clk.tick(pendingTTL + time.Second)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)}); r.code != 401 || r.body["code"] != "two_factor_expired" {
		t.Fatalf("expired token: %d %v", r.code, r.body)
	}
	// wrong codes wear a token out (after pendingTries); the account limiter is reset between, so this is the token's own
	p = e.passwordStep(c, "admin@x.org", ab)
	for i := 0; i < pendingTries; i++ {
		if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": "000000"}); r.code != 401 || r.body["code"] != "wrong_code" {
			t.Fatalf("try %d: %d %v", i, r.code, r.body)
		}
	}
	u, _ := e.app.userByEmail("admin@x.org")
	e.app.totpAcct.clear("2fa|" + u.ID)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)}); r.code != 401 || r.body["code"] != "two_factor_expired" {
		t.Fatalf("worn-out token: %d %v", r.code, r.body)
	}
	// a password change ends the pending sign-ins issued for the old password
	p = e.passwordStep(c, "admin@x.org", ab)
	u, _ = e.app.userByEmail("admin@x.org")
	e.app.db.Exec(`UPDATE users SET auth_hash='changed' WHERE id=?`, u.ID)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)}); r.code != 401 || r.body["code"] != "two_factor_expired" {
		t.Fatalf("after a password change: %d %v", r.code, r.body)
	}
}

func TestTwoFactorCodesAreRateLimited(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	secret, _ := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)
	// per account, across sign-ins (and sources): totpAcctMax codes per window
	for i := 0; i < totpAcctMax; i++ {
		c := e.client()
		p := e.passwordStep(c, "admin@x.org", ab)
		if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": "000000"}); r.code != 401 {
			t.Fatalf("try %d: %d", i, r.code)
		}
	}
	c := e.client()
	p := e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)}); r.code != 429 {
		t.Fatalf("over the limit, even with the right code: %d %v", r.code, r.body)
	}
	// turned away unchecked: the token is not used up
	u, _ := e.app.userByEmail("admin@x.org")
	e.app.totpAcct.clear("2fa|" + u.ID)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)}); r.code != 200 {
		t.Fatalf("after the window: %d %v", r.code, r.body)
	}
	// per day as well
	for i := 0; i < totpDayMax; i++ {
		e.app.totpDay.take("2fa|" + u.ID)
	}
	c = e.client()
	p = e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": "000000"}); r.code != 429 {
		t.Fatalf("over the daily limit: %d", r.code)
	}
	// and per source
	e.app.totpDay.clear("2fa|" + u.ID)
	for i := 0; i < 30; i++ {
		e.app.loginIP.take("2fa|127.0.0.1")
	}
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": "000000"}); r.code != 429 {
		t.Fatalf("over the source's limit: %d", r.code)
	}
	// the code checks behind Account count in the same account buckets
	e.app.loginIP.clear("2fa|127.0.0.1")
	for i := 0; i < totpAcctMax; i++ {
		e.app.totpAcct.take("2fa|" + u.ID)
	}
	if code, _ := admin.do("POST", "/api/me/2fa/disable", map[string]any{"current_auth": ab["auth"], "code": codeAt(t, secret, clk.at)}, true); code != 429 {
		t.Fatalf("disable over the limit: %d", code)
	}
	// a password change clears them: whoever was guessing doesn't have the new password
	e.app.forgetCodeTries(u.ID)
	if !e.app.totpAcct.allowed("2fa|"+u.ID) || !e.app.totpDay.allowed("2fa|"+u.ID) {
		t.Fatal("not cleared")
	}
}

func TestRecoveryCodesWorkOnce(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	_, codes := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)

	c := e.client()
	p := e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": strings.ToUpper(codes[0])}); r.code != 200 {
		t.Fatalf("recovery code: %d %v", r.code, r.body)
	}
	if _, out := admin.do("GET", "/api/me/2fa", nil, false); out["recovery_codes_left"].(float64) != 9 {
		t.Fatalf("left: %v", out)
	}
	c = e.client()
	p = e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codes[0]}); r.code != 401 {
		t.Fatalf("used code again: %d", r.code)
	}
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": strings.ReplaceAll(codes[1], "-", "")}); r.code != 200 {
		t.Fatalf("second code: %d %v", r.code, r.body)
	}
	// another account's code is no code here
	bob, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	_, bobCodes := e.enable2FA(bob, bb)
	c = e.client()
	p = e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": bobCodes[0]}); r.code != 401 {
		t.Fatalf("someone else's code: %d", r.code)
	}
}

func TestTurningTwoFactorOffAndNewCodes(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	secret, codes := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)

	// new recovery codes: password and a code; the old ones stop working
	if code, _ := admin.do("POST", "/api/me/2fa/recovery-codes", map[string]any{"current_auth": ab["auth"], "code": "000000"}, true); code != 403 {
		t.Fatalf("wrong code: %d", code)
	}
	if code, _ := admin.do("POST", "/api/me/2fa/recovery-codes", map[string]any{"current_auth": rb(32), "code": codeAt(t, secret, clk.at)}, true); code != 403 {
		t.Fatalf("wrong password: %d", code)
	}
	code, out := admin.do("POST", "/api/me/2fa/recovery-codes", map[string]any{"current_auth": ab["auth"], "code": codeAt(t, secret, clk.at)}, true)
	if code != 200 || len(out["recovery_codes"].([]any)) != 10 {
		t.Fatalf("new codes: %d %v", code, out)
	}
	fresh := out["recovery_codes"].([]any)[0].(string)
	c := e.client()
	p := e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codes[2]}); r.code != 401 {
		t.Fatalf("old recovery code: %d", r.code)
	}

	// turning it off: password and a code (a recovery code will do)
	if code, _ := admin.do("POST", "/api/me/2fa/disable", map[string]any{"current_auth": ab["auth"]}, true); code != 403 {
		t.Fatalf("without a code: %d", code)
	}
	if code, _ := admin.do("POST", "/api/me/2fa/disable", map[string]any{"current_auth": rb(32), "code": fresh}, true); code != 403 {
		t.Fatalf("wrong password: %d", code)
	}
	if code, out := admin.do("POST", "/api/me/2fa/disable", map[string]any{"current_auth": ab["auth"], "code": fresh}, true); code != 200 {
		t.Fatalf("disable: %d %v", code, out)
	}
	if _, out := admin.do("GET", "/api/me", nil, false); out["two_factor"] != false {
		t.Fatal("still on")
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM recovery_codes`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d recovery codes left behind", n)
	}
	e.login("admin@x.org", ab) // the password alone again
	if code, _ := admin.do("POST", "/api/me/2fa/disable", map[string]any{"current_auth": ab["auth"], "code": "000000"}, true); code != 409 {
		t.Fatalf("disable while off: %d", code)
	}
}

func TestAdminTurnsTwoFactorOff(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	bob, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.enable2FA(bob, bb)
	clk.tick(30 * time.Second)
	u, _ := e.app.userByEmail("bob@x.org")
	if _, out := admin.do("GET", "/api/admin/users", nil, false); !strings.Contains(mustJSON(out), `"two_factor":true`) {
		t.Fatalf("admin list doesn't show it: %v", out)
	}
	if code, _ := bob.do("DELETE", "/api/admin/users/"+u.ID+"/2fa", nil, true); code != 404 {
		t.Fatalf("a non-admin: %d", code)
	}
	a, _ := e.app.userByEmail("admin@x.org")
	if code, _ := admin.do("DELETE", "/api/admin/users/"+a.ID+"/2fa", nil, true); code != 400 {
		t.Fatalf("own account: %d", code)
	}
	// a sign-in of bob's waiting for its code ends with it
	waiting := e.client()
	p := e.passwordStep(waiting, "bob@x.org", bb)
	if code, out := admin.do("DELETE", "/api/admin/users/"+u.ID+"/2fa", nil, true); code != 200 {
		t.Fatalf("reset: %d %v", code, out)
	}
	if code, _ := admin.do("DELETE", "/api/admin/users/"+u.ID+"/2fa", nil, true); code != 409 {
		t.Fatalf("reset twice: %d", code)
	}
	if r := waiting.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": "000000"}); r.code != 401 || r.body["code"] != "two_factor_expired" {
		t.Fatalf("pending after reset: %d %v", r.code, r.body)
	}
	// bob signs in with the password alone, and sees why
	fresh := e.login("bob@x.org", bb)
	_, out := fresh.do("GET", "/api/me/notices", nil, false)
	l := out["notices"].([]any)
	if len(l) != 1 || l[0].(map[string]any)["kind"] != noticeTwoFactorReset {
		t.Fatalf("notices: %v", out)
	}
	_, out = bob.do("GET", "/api/me/notices", nil, false)
	if !strings.Contains(mustJSON(out), noticeTwoFactorReset) {
		t.Fatalf("old device: %v", out)
	}
	_, audit := admin.do("GET", "/api/admin/audit", nil, false)
	if !strings.Contains(mustJSON(audit), "two-step sign-in turned off") {
		t.Fatalf("audit: %v", audit)
	}
	_ = ab
}

func TestServerConsoleTurnsTwoFactorOff(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	e.enable2FA(admin, ab)
	if out, err := e.cli("reset-2fa", "admin@x.org"); err != nil || !strings.Contains(out, "is off") {
		t.Fatalf("reset-2fa: %v %q", err, out)
	}
	e.login("admin@x.org", ab)
	if out, err := e.cli("reset-2fa", "admin@x.org"); err != nil || !strings.Contains(out, "already off") {
		t.Fatalf("again: %v %q", err, out)
	}
}

func TestDemoCannotTurnOnTwoFactor(t *testing.T) {
	_, _, demo, _, _ := demoEnv(t)
	if code, out := demo.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": rb(32)}, true); code != 403 || out["error"] != demoRefused {
		t.Fatalf("demo setup: %d %v", code, out)
	}
	if code, out := demo.do("GET", "/api/me/2fa", nil, false); code != 200 || out["available"] != false {
		t.Fatalf("demo status: %d %v", code, out)
	}
}

func TestNewSignInNoticeReachesTheOtherDevices(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	laptop := e.login("admin@x.org", ab)
	st, _ := laptop.events()
	st.ready(t)
	clk.tick(time.Second) // a device signed in the same second may see the other's sign-in too
	// a new sign-in, as the Android app names itself
	phone := e.client()
	if r := phone.post("/api/auth/login", map[string]any{"email": "admin@x.org", "auth": ab["auth"]}); r.code != 200 {
		t.Fatalf("login: %d", r.code)
	}
	ev, ok := st.next(t, 5*time.Second)
	if !ok || ev.name != "changed" || !strings.Contains(mustJSON(ev.data), "notices") {
		t.Fatalf("live ping: %v %v", ok, ev)
	}
	_, out := laptop.do("GET", "/api/me/notices", nil, false)
	l := out["notices"].([]any)
	if len(l) != 1 {
		t.Fatalf("notices: %v", out)
	}
	n := l[0].(map[string]any)
	if n["kind"] != noticeSignIn || n["device"] != "Test phone (Android app)" || n["at"].(float64) == 0 {
		t.Fatalf("notice: %v", n)
	}
	// the device list shows the same name
	if !strings.Contains(mustJSON(sessionList(t, laptop)), "Test phone (Android app)") {
		t.Fatal("not in the device list")
	}
	// the admin's first device (signed in before) sees it too; the new phone doesn't see its own sign-in
	// (it was also told about the laptop's sign-in)
	if _, out := admin.do("GET", "/api/me/notices", nil, false); len(out["notices"].([]any)) != 2 {
		t.Fatalf("first device: %v", out)
	}
	if _, out := phone.do("GET", "/api/me/notices", nil, false); len(out["notices"].([]any)) != 0 {
		t.Fatalf("own sign-in shown: %v", out)
	}
	// dismissed on one device, gone on all, and never back
	id := int64(n["id"].(float64))
	if code, _ := laptop.do("POST", "/api/me/notices/"+itoa(id)+"/dismiss", nil, true); code != 200 {
		t.Fatalf("dismiss: %d", code)
	}
	for c, left := range map[*client]int{laptop: 0, admin: 1} {
		if _, out := c.do("GET", "/api/me/notices", nil, false); len(out["notices"].([]any)) != left || strings.Contains(mustJSON(out), "Test phone") {
			t.Fatalf("dismissed notice back: %v", out)
		}
	}
	// someone else's notice can't be dismissed
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.login("admin@x.org", ab)
	_, out = admin.do("GET", "/api/me/notices", nil, false)
	other := int64(out["notices"].([]any)[0].(map[string]any)["id"].(float64))
	if code, _ := bob.do("POST", "/api/me/notices/"+itoa(other)+"/dismiss", nil, true); code != 404 {
		t.Fatalf("someone else's notice: %d", code)
	}
	// a device signed in later doesn't get the news of earlier sign-ins
	clk.tick(time.Second)
	late := e.login("admin@x.org", ab)
	if _, out := late.do("GET", "/api/me/notices", nil, false); len(out["notices"].([]any)) != 0 {
		t.Fatalf("earlier sign-ins on a later device: %v", out)
	}
}

func TestSignInWithCodeNotifiesToo(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	secret, _ := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)
	c := e.client()
	p := e.passwordStep(c, "admin@x.org", ab)
	// the password step alone tells nobody (and it isn't a sign-in yet)
	if _, out := admin.do("GET", "/api/me/notices", nil, false); len(out["notices"].([]any)) != 0 {
		t.Fatalf("notice before the code: %v", out)
	}
	c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)})
	if _, out := admin.do("GET", "/api/me/notices", nil, false); len(out["notices"].([]any)) != 1 {
		t.Fatalf("no notice after the code: %v", out)
	}
}

func TestNoticesArePruned(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	u, _ := e.app.userByEmail("admin@x.org")
	for i := 0; i < noticesKept+20; i++ {
		e.app.notify(u.ID, noticeSignIn, "x", "")
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM notices WHERE user_id=?`, u.ID).Scan(&n)
	if n != noticesKept {
		t.Fatalf("%d kept", n)
	}
}

func TestPendingStoreKeepsFewPerAccount(t *testing.T) {
	p := newPendingStore()
	now := time.Now()
	for i := 0; i < 5; i++ {
		p.add(itoa(int64(i)), &pendingSignIn{userID: "u", created: now.Add(time.Duration(i) * time.Second), expires: now.Add(time.Hour)}, now)
	}
	if p.count() != pendingPer {
		t.Fatalf("%d kept", p.count())
	}
	if _, err := p.claim("0", now); err == nil {
		t.Fatal("the oldest kept")
	}
	if _, err := p.claim("4", now); err != nil {
		t.Fatal("the newest dropped")
	}
	if _, err := p.claim("4", now); err != errPendingBusy {
		t.Fatalf("claimed twice at once: %v", err)
	}
}

func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

// Whoever has the recovery key can set a new password, but must not be able to wipe the account's code count with it
// over and over: a recovery ends the pending sign-ins (issued for the old password) and keeps the count. A password
// change (from a session that passed the code step) still clears it.
func TestRecoveryKeepsTheCodeCount(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	secret, _ := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)
	u, _ := e.app.userByEmail("admin@x.org")
	for i := 0; i < totpAcctMax; i++ {
		e.app.totpAcct.take("2fa|" + u.ID)
	}
	c := e.client()
	p := e.passwordStep(c, "admin@x.org", ab)

	_, out := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": ab["recovery_verifier"].(string)}, false)
	nb := bundle()
	fin := map[string]any{"ticket": out["ticket"], "new_auth": nb["auth"], "new_kdf": nb["kdf"], "new_wrapped_master_pw": nb["wrapped_master_pw"],
		"new_wrapped_master_recovery": nb["wrapped_master_recovery"], "new_recovery_verifier": nb["recovery_verifier"]}
	if code, out := c.do("POST", "/api/auth/recover/finish", fin, false); code != 200 {
		t.Fatalf("recover: %d %v", code, out)
	}
	if e.app.totpAcct.allowed("2fa|" + u.ID) {
		t.Fatal("a recovery cleared the code count")
	}
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)}); r.code != 401 || r.body["code"] != "two_factor_expired" {
		t.Fatalf("pending sign-in survived the recovery: %d %v", r.code, r.body)
	}
	// the password change of a signed-in device clears it
	e.app.totpAcct.clear("2fa|" + u.ID)
	nc := e.client()
	np := e.passwordStep(nc, "admin@x.org", nb)
	if r := nc.post("/api/auth/login/2fa", map[string]any{"pending": np, "code": codeAt(t, secret, clk.at)}); r.code != 200 {
		t.Fatalf("sign in after recovery: %d %v", r.code, r.body)
	}
	for i := 0; i < totpAcctMax; i++ {
		e.app.totpAcct.take("2fa|" + u.ID)
	}
	pb := bundle()
	if code, out := nc.do("POST", "/api/auth/password", map[string]any{"current_auth": nb["auth"], "new_auth": pb["auth"], "new_kdf": pb["kdf"], "new_wrapped_master_pw": pb["wrapped_master_pw"]}, true); code != 200 {
		t.Fatalf("password change: %d %v", code, out)
	}
	if !e.app.totpAcct.allowed("2fa|" + u.ID) {
		t.Fatal("a password change kept the code count")
	}
}

// A notice can be dismissed only by a session that is shown it: whoever signed in with a stolen password can't take
// down the notice about their own sign-in from the real person's devices, nor, from a second sign-in (even in the
// same second), the notice about their first.
func TestNoticesAreDismissedOnlyWhereTheyAreShown(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	clk.tick(time.Second)
	thief := e.login("admin@x.org", ab)
	thief2 := e.login("admin@x.org", ab) // the same second
	_, out := admin.do("GET", "/api/me/notices", nil, false)
	l := out["notices"].([]any)
	if len(l) != 2 {
		t.Fatalf("notices: %v", out)
	}
	newer := int64(l[0].(map[string]any)["id"].(float64)) // about thief2
	older := int64(l[1].(map[string]any)["id"].(float64)) // about thief
	for _, x := range []struct {
		c  *client
		id int64
	}{{thief, older}, {thief2, newer}, {thief2, older}} {
		if code, _ := x.c.do("POST", "/api/me/notices/"+itoa(x.id)+"/dismiss", nil, true); code != 404 {
			t.Fatalf("dismissed notice %d from a session it isn't shown on: %d", x.id, code)
		}
	}
	if _, out := admin.do("GET", "/api/me/notices", nil, false); len(out["notices"].([]any)) != 2 {
		t.Fatalf("taken down: %v", out)
	}
	// the earlier sign-in is shown the later one, and may dismiss it
	if code, _ := thief.do("POST", "/api/me/notices/"+itoa(newer)+"/dismiss", nil, true); code != 200 {
		t.Fatalf("dismiss a later sign-in: %d", code)
	}
	if code, _ := admin.do("POST", "/api/me/notices/"+itoa(older)+"/dismiss", nil, true); code != 200 {
		t.Fatalf("dismiss on the device that was signed in before: %d", code)
	}
	if _, out := admin.do("GET", "/api/me/notices", nil, false); len(out["notices"].([]any)) != 0 {
		t.Fatalf("left: %v", out)
	}
}

// The newest noticesKept per account, whatever the other accounts get meanwhile (ids are shared by all accounts).
func TestNoticesArePrunedPerAccount(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	e.acceptInvite(e.invite(admin, "bob@x.org"))
	a, _ := e.app.userByEmail("admin@x.org")
	b, _ := e.app.userByEmail("bob@x.org")
	n := noticesKept - 10
	for i := 0; i < n; i++ {
		e.app.notify(a.ID, noticeSignIn, "x", "")
		e.app.notify(b.ID, noticeSignIn, "x", "")
	}
	for _, u := range []*user{a, b} {
		var got int
		e.app.db.QueryRow(`SELECT COUNT(*) FROM notices WHERE user_id=?`, u.ID).Scan(&got)
		if got != n {
			t.Fatalf("%s: %d kept, want %d", u.Email, got, n)
		}
	}
}

// Dismissed notices are never shown again: they go before any that is still shown.
func TestDismissedNoticesArePrunedFirst(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin("admin@x.org")
	u, _ := e.app.userByEmail("admin@x.org")
	e.app.notify(u.ID, noticeTwoFactorReset, "", "")
	var first int64
	e.app.db.QueryRow(`SELECT MAX(id) FROM notices WHERE user_id=?`, u.ID).Scan(&first)
	for i := 0; i < noticesKept; i++ {
		e.app.notify(u.ID, noticeSignIn, "x", "")
		if i == 0 {
			e.app.db.Exec(`UPDATE notices SET dismissed=1 WHERE user_id=? AND id<>?`, u.ID, first)
		}
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM notices WHERE id=?`, first).Scan(&n)
	if n != 1 {
		t.Fatal("a shown notice went before a dismissed one")
	}
}

// The setup's confirming code is read as typed, like the code at sign-in ("123 456", "123-456"); new recovery codes
// are in the activity log like the other changes to two-step sign-in.
func TestTwoFactorSetupCodeAsTypedAndNewCodesLogged(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	_, out := admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"]}, true)
	secret := out["secret"].(string)
	c := codeAt(t, secret, clk.at)
	if code, out := admin.do("POST", "/api/me/2fa/enable", map[string]any{"code": " " + c[:3] + " - " + c[3:]}, true); code != 200 {
		t.Fatalf("enable with a spaced code: %d %v", code, out)
	}
	clk.tick(30 * time.Second)
	if code, out := admin.do("POST", "/api/me/2fa/recovery-codes", map[string]any{"current_auth": ab["auth"], "code": codeAt(t, secret, clk.at)}, true); code != 200 {
		t.Fatalf("new codes: %d %v", code, out)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action LIKE '%recovery codes%'`).Scan(&n)
	if n != 1 {
		t.Fatalf("new recovery codes logged %d times", n)
	}
}

func shownKinds(t *testing.T, c *client) []string {
	t.Helper()
	_, out := c.do("GET", "/api/me/notices", nil, false)
	var k []string
	for _, x := range out["notices"].([]any) {
		k = append(k, x.(map[string]any)["kind"].(string))
	}
	return k
}

// A password step on an account with two-step sign-in that isn't followed by a right code (it expired, wore out, or
// was pushed out by newer ones) is shown to the account's devices once the pending sign-in can no longer finish:
// whoever has the password could otherwise keep the real person's sign-ins from finishing without a trace. One that
// finished shows nothing more than the new sign-in. At most one such notice an hour.
func TestUnfinishedPasswordStepIsNoticed(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	secret, _ := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)
	count := func() (n int) {
		for _, k := range shownKinds(t, admin) {
			if k == noticePasswordUsed {
				n++
			}
		}
		return
	}

	// finished: nothing
	c := e.client()
	p := e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)}); r.code != 200 {
		t.Fatalf("code: %d", r.code)
	}
	clk.tick(pendingTTL + time.Second)
	if n := count(); n != 0 {
		t.Fatalf("a finished sign-in left %d notices", n)
	}

	// not finished: shown once it has expired, not before
	e.passwordStep(e.client(), "admin@x.org", ab)
	clk.tick(pendingTTL / 2)
	if n := count(); n != 0 {
		t.Fatal("shown while it can still finish")
	}
	// another one within the hour, then the real person signs in: still one notice, and it stays
	e.passwordStep(e.client(), "admin@x.org", ab)
	clk.tick(30 * time.Second)
	c = e.client()
	p = e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)}); r.code != 200 {
		t.Fatalf("code: %d", r.code)
	}
	clk.tick(pendingTTL + time.Second)
	if n := count(); n != 1 {
		t.Fatalf("%d notices, want 1", n)
	}
	_, out := admin.do("GET", "/api/me/notices", nil, false)
	for _, x := range out["notices"].([]any) {
		if n := x.(map[string]any); n["kind"] == noticePasswordUsed && n["device"] != "" {
			t.Fatalf("notice: %v", n)
		}
	}
	// a later sign-in sees it too (it is about the account, not about a session)
	clk.tick(time.Second)
	nc := e.client()
	np := e.passwordStep(nc, "admin@x.org", ab)
	clk.tick(30 * time.Second)
	if r := nc.post("/api/auth/login/2fa", map[string]any{"pending": np, "code": codeAt(t, secret, clk.at)}); r.code != 200 {
		t.Fatalf("code: %d", r.code)
	}
	if k := shownKinds(t, nc); len(k) != 1 || k[0] != noticePasswordUsed { // the earlier sign-ins aren't news to it
		t.Fatalf("on a later device: %v", k)
	}

	// an hour on: a pending sign-in pushed out by newer ones counts too, even when one of those finishes
	clk.tick(time.Hour)
	for _, x := range []*client{admin, nc} {
		_, out := x.do("GET", "/api/me/notices", nil, false)
		for _, n := range out["notices"].([]any) {
			x.do("POST", "/api/me/notices/"+itoa(int64(n.(map[string]any)["id"].(float64)))+"/dismiss", nil, true)
		}
	}
	for i := 0; i < pendingPer; i++ {
		e.passwordStep(e.client(), "admin@x.org", ab)
	}
	clk.tick(30 * time.Second)
	c = e.client()
	p = e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codeAt(t, secret, clk.at)}); r.code != 200 {
		t.Fatalf("code: %d", r.code)
	}
	clk.tick(pendingTTL + time.Second)
	if n := count(); n != 1 {
		t.Fatalf("pushed-out sign-ins: %d notices, want 1", n)
	}
}

// The Android app checks for notices in the background (mobile/src/noticeCheck.ts) with X-CF-Background: such a GET
// gets the same answer, but doesn't count as using the device: the session's last activity and idle end stay.
func TestBackgroundCheckIsNotActivity(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	clk.tick(time.Second)
	e.login("admin@x.org", ab)
	seen := func() (last, exp int64) {
		t.Helper()
		e.app.db.QueryRow(`SELECT last_seen, expires_at FROM sessions ORDER BY created_at LIMIT 1`).Scan(&last, &exp)
		return
	}
	last0, exp0 := seen()
	clk.tick(10 * time.Minute)
	get := func(path string, background bool) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest("GET", e.srv.URL+path, nil)
		if background {
			req.Header.Set("X-CF-Background", "1")
		}
		resp, err := admin.c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	code, out := get("/api/me/notices", true)
	if code != 200 || len(out["notices"].([]any)) != 1 {
		t.Fatalf("background check: %d %v", code, out)
	}
	if last, exp := seen(); last != last0 || exp != exp0 {
		t.Fatalf("background check counted as activity: %d/%d -> %d/%d", last0, exp0, last, exp)
	}
	// only a GET: a write is always the person (and still needs its CSRF token)
	if code, _ := admin.do("POST", "/api/me/notices/1/dismiss", nil, false); code != 403 {
		t.Fatalf("dismiss without token: %d", code)
	}
	// the same request without the header is activity, as before
	if code, _ := get("/api/me/notices", false); code != 200 {
		t.Fatalf("check: %d", code)
	}
	if last, exp := seen(); last == last0 || exp <= exp0 {
		t.Fatalf("a normal request isn't activity: %d/%d -> %d/%d", last0, exp0, last, exp)
	}
}
