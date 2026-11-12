package main

import (
	"testing"
	"time"
)

// Regression tests for the security review of the passkey code: an authenticator setup or a passkey registration
// begun while two-step sign-in was off must not become a second step once it is on.

// hostAdmin sets up the first account on the passkey host, with two-step sign-in off.
func (e *env) hostAdmin() (*client, map[string]any) {
	e.t.Helper()
	c := e.hostClient()
	b := with(bundle(), "setup_token", e.knownSetupToken(), "email", "admin@x.org")
	if code, out := c.do("POST", "/api/setup", b, false); code != 201 {
		e.t.Fatalf("setup: %d %v", code, out)
	}
	return c, b
}

func TestStaleAuthenticatorSetupCannotBeFinishedOnceTwoStepIsOn(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	attacker, ab := e.hostAdmin()
	// the attacker, with a session and the password while two-step sign-in is off, starts an authenticator setup
	code, setup := attacker.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"]}, true)
	if code != 200 {
		t.Fatalf("setup: %d %v", code, setup)
	}
	u, _ := e.app.userByEmail("admin@x.org")
	stale := u.TOTPPending
	// the owner then turns two-step sign-in on with a passkey
	victim := e.hostClient()
	if code, _ := victim.do("POST", "/api/auth/login", map[string]any{"email": "admin@x.org", "auth": ab["auth"]}, false); code != 200 {
		t.Fatalf("login: %d", code)
	}
	e.addPasskey(victim, ab, newSoftKey(t))
	// adding the passkey dropped the setup
	u, _ = e.app.userByEmail("admin@x.org")
	if u.TOTPPending != "" {
		t.Fatal("an authenticator setup survived adding a passkey")
	}
	if code, out := attacker.do("POST", "/api/me/2fa/enable", map[string]any{"code": codeAt(t, setup["secret"].(string), clk.at)}, true); code != 409 {
		t.Fatalf("stale setup finished after the passkey: %d %v", code, out)
	}
	// and even if it had stayed (a race): one made without a second step can't be finished while two-step sign-in is on
	e.app.db.Exec(`UPDATE users SET totp_pending=? WHERE id=?`, stale, u.ID)
	if code, out := attacker.do("POST", "/api/me/2fa/enable", map[string]any{"code": codeAt(t, setup["secret"].(string), clk.at)}, true); code != 409 {
		t.Fatalf("setup without a second step finished while two-step sign-in is on: %d %v", code, out)
	}
	if _, st := victim.do("GET", "/api/me/2fa", nil, false); st["totp"] != false {
		t.Fatalf("status: %v", st)
	}
}

func TestAuthenticatorSetupExpires(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	_, setup := admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"]}, true)
	clk.tick(16 * time.Minute)
	if code, out := admin.do("POST", "/api/me/2fa/enable", map[string]any{"code": codeAt(t, setup["secret"].(string), clk.at)}, true); code != 409 {
		t.Fatalf("an old setup was finished: %d %v", code, out)
	}
	// a fresh one, finished in time, works
	_, setup = admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"]}, true)
	clk.tick(14 * time.Minute)
	if code, out := admin.do("POST", "/api/me/2fa/enable", map[string]any{"code": codeAt(t, setup["secret"].(string), clk.at)}, true); code != 200 {
		t.Fatalf("enable in time: %d %v", code, out)
	}
}

func TestPasswordChangeDropsAuthenticatorSetup(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"]}, true)
	nb := bundle()
	if code, out := admin.do("POST", "/api/auth/password", map[string]any{"current_auth": ab["auth"], "new_auth": nb["auth"], "new_kdf": nb["kdf"], "new_wrapped_master_pw": nb["wrapped_master_pw"]}, true); code != 200 {
		t.Fatalf("password: %d %v", code, out)
	}
	if u, _ := e.app.userByEmail("admin@x.org"); u.TOTPPending != "" {
		t.Fatal("an authenticator setup survived the password change")
	}
	admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": nb["auth"]}, true)
	c := e.client()
	_, out := c.do("POST", "/api/auth/recover/start", map[string]string{"email": "admin@x.org", "recovery_auth": ab["recovery_verifier"].(string)}, false)
	rb := bundle()
	fin := map[string]any{"ticket": out["ticket"], "new_auth": rb["auth"], "new_kdf": rb["kdf"], "new_wrapped_master_pw": rb["wrapped_master_pw"],
		"new_wrapped_master_recovery": rb["wrapped_master_recovery"], "new_recovery_verifier": rb["recovery_verifier"]}
	if code, out := c.do("POST", "/api/auth/recover/finish", fin, false); code != 200 {
		t.Fatalf("recover: %d %v", code, out)
	}
	if u, _ := e.app.userByEmail("admin@x.org"); u.TOTPPending != "" {
		t.Fatal("an authenticator setup survived the recovery")
	}
}

func TestPasskeyRegistrationBegunWhileOffIsRefusedOnceOn(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	attacker, ab := e.hostAdmin()
	// begun while two-step sign-in is off: no second step asked for
	code, begin := attacker.do("POST", "/api/me/passkeys/register/begin", map[string]any{"current_auth": ab["auth"]}, true)
	if code != 200 {
		t.Fatalf("begin: %d %v", code, begin)
	}
	// the owner turns two-step sign-in on (an authenticator app) on another device
	victim := e.login("admin@x.org", ab)
	e.enable2FA(victim, ab)
	clk.tick(time.Minute)
	if code, out := attacker.do("POST", "/api/me/passkeys/register/finish", map[string]any{"credential": newSoftKey(t).create(begin["options"].(map[string]any))}, true); code != 409 || out["code"] != "passkey_expired" {
		t.Fatalf("passkey added as a second step without one: %d %v", code, out)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM passkeys`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d passkeys", n)
	}
}

func TestRemovingAMissingAuthenticatorKeepsTheRecoveryCode(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	admin, ab, _, codes := e.adminWithPasskey()
	if code, out := admin.do("POST", "/api/me/2fa/totp/remove", map[string]any{"current_auth": ab["auth"], "code": codes[0]}, true); code != 409 {
		t.Fatalf("remove a missing app: %d %v", code, out)
	}
	if _, st := admin.do("GET", "/api/me/2fa", nil, false); st["recovery_codes_left"] != float64(10) {
		t.Fatalf("a recovery code was used up for nothing: %v", st)
	}
}

func TestRemovingTheLastPasskeyDropsOpenCeremonies(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	admin, ab, _, codes := e.adminWithPasskey()
	code, begin := admin.do("POST", "/api/me/passkeys/register/begin", map[string]any{"current_auth": ab["auth"], "code": codes[0]}, true)
	if code != 200 {
		t.Fatalf("begin: %d %v", code, begin)
	}
	_, l := admin.do("GET", "/api/me/passkeys", nil, false)
	id := l["passkeys"].([]any)[0].(map[string]any)["id"].(string)
	if code, out := admin.do("DELETE", "/api/me/passkeys/"+id, map[string]any{"current_auth": ab["auth"], "code": codes[1]}, true); code != 200 || out["two_factor"] != false {
		t.Fatalf("delete the last: %d %v", code, out)
	}
	if code, out := admin.do("POST", "/api/me/passkeys/register/finish", map[string]any{"credential": newSoftKey(t).create(begin["options"].(map[string]any))}, true); code != 409 {
		t.Fatalf("a registration outlived two-step sign-in: %d %v", code, out)
	}
}

// Removing the authenticator app when it was the only second step turns two-step sign-in off: a passkey registration
// begun under it (with a code) can't be finished afterwards, as when the last passkey goes.
func TestRemovingTheOnlyAuthenticatorDropsOpenCeremonies(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin := e.hostClient()
	ab := with(bundle(), "setup_token", e.knownSetupToken(), "email", "admin@x.org")
	if code, out := admin.do("POST", "/api/setup", ab, false); code != 201 {
		t.Fatalf("setup: %d %v", code, out)
	}
	secret, codes := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)
	code, begin := admin.do("POST", "/api/me/passkeys/register/begin", map[string]any{"current_auth": ab["auth"], "code": codeAt(t, secret, clk.at)}, true)
	if code != 200 {
		t.Fatalf("begin: %d %v", code, begin)
	}
	if code, out := admin.do("POST", "/api/me/2fa/totp/remove", map[string]any{"current_auth": ab["auth"], "code": codes[0]}, true); code != 200 || out["two_factor"] != false {
		t.Fatalf("remove the authenticator: %d %v", code, out)
	}
	if code, out := admin.do("POST", "/api/me/passkeys/register/finish", map[string]any{"credential": newSoftKey(t).create(begin["options"].(map[string]any))}, true); code != 409 {
		t.Fatalf("a registration outlived two-step sign-in: %d %v", code, out)
	}
	if _, out := admin.do("GET", "/api/me", nil, false); out["two_factor"] != false {
		t.Fatal("two-step sign-in back on")
	}
}
