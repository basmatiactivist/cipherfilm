package main

import (
	"testing"
	"time"
)

// With two-step sign-in on, changing the password, making a new recovery key and deleting the account take the second
// step too, as turning two-step sign-in off does: a session and the password alone can't do them. An app that sends
// none is told so plainly (second_step_required); a wrong code is refused and counted.
func TestCredentialChangesNeedTheSecondStep(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	secret, codes := e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)
	u, _ := e.app.userByEmail("admin@x.org")
	nb := bundle()
	pw := func(extra ...any) (int, map[string]any) {
		return admin.do("POST", "/api/auth/password", with(map[string]any{"current_auth": ab["auth"], "new_auth": nb["auth"],
			"new_kdf": nb["kdf"], "new_wrapped_master_pw": nb["wrapped_master_pw"]}, extra...), true)
	}
	rk := func(extra ...any) (int, map[string]any) {
		return admin.do("POST", "/api/auth/recovery-key", with(map[string]any{"current_auth": ab["auth"],
			"wrapped_master_recovery": rb(wrappedLen), "recovery_verifier": rb(32)}, extra...), true)
	}
	del := func(c *client, auth any, extra ...any) (int, map[string]any) {
		return c.do("DELETE", "/api/me", with(map[string]any{"current_auth": auth}, extra...), true)
	}
	for name, call := range map[string]func(...any) (int, map[string]any){"password": pw, "recovery key": rk} {
		if code, out := call(); code != 403 || out["code"] != stepUpRequired || out["error"] == "" {
			t.Fatalf("%s without a second step: %d %v", name, code, out)
		}
		if code, out := call("code", "000000"); code != 403 || out["code"] != "wrong_code" {
			t.Fatalf("%s with a wrong code: %d %v", name, code, out)
		}
	}
	cur, _ := e.app.userByID(u.ID)
	if cur.AuthHash != u.AuthHash || cur.RecoveryHash != u.RecoveryHash {
		t.Fatal("changed without the second step")
	}
	// with it: an authenticator code, a recovery code
	if code, out := rk("code", codeAt(t, secret, clk.at)); code != 200 {
		t.Fatalf("recovery key with a code: %d %v", code, out)
	}
	if code, out := pw("code", codes[0]); code != 200 {
		t.Fatalf("password with a recovery code: %d %v", code, out)
	}

	// deleting an account with two-step sign-in
	bob, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	bobSecret, _ := e.enable2FA(bob, bb)
	clk.tick(30 * time.Second)
	if code, out := del(bob, bb["auth"]); code != 403 || out["code"] != stepUpRequired {
		t.Fatalf("delete without a second step: %d %v", code, out)
	}
	if code, out := del(bob, bb["auth"], "code", "000000"); code != 403 || out["code"] != "wrong_code" {
		t.Fatalf("delete with a wrong code: %d %v", code, out)
	}
	if code, out := del(bob, bb["auth"], "code", codeAt(t, bobSecret, clk.at)); code != 200 {
		t.Fatalf("delete with a code: %d %v", code, out)
	}
	if _, err := e.app.userByEmail("bob@x.org"); err == nil {
		t.Fatal("still there")
	}
}

// A passkey answers the second step of these changes as it does for turning two-step sign-in off.
func TestCredentialChangesTakeAPasskey(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	admin, ab, k, _ := e.adminWithPasskey()
	nb := bundle()
	if code, out := admin.do("POST", "/api/auth/password", map[string]any{"current_auth": ab["auth"], "new_auth": nb["auth"],
		"new_kdf": nb["kdf"], "new_wrapped_master_pw": nb["wrapped_master_pw"]}, true); code != 403 || out["code"] != stepUpRequired {
		t.Fatalf("without: %d %v", code, out)
	}
	if code, out := admin.do("POST", "/api/auth/password", map[string]any{"current_auth": ab["auth"], "new_auth": nb["auth"],
		"new_kdf": nb["kdf"], "new_wrapped_master_pw": nb["wrapped_master_pw"], "passkey": e.proofPasskey(admin, k)}, true); code != 200 {
		t.Fatalf("with a passkey: %d %v", code, out)
	}
}

// Without two-step sign-in nothing changes: the password alone, as before.
func TestCredentialChangesWithoutTwoStepNeedOnlyThePassword(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	if code, out := admin.do("POST", "/api/auth/recovery-key", map[string]any{"current_auth": ab["auth"],
		"wrapped_master_recovery": rb(wrappedLen), "recovery_verifier": rb(32)}, true); code != 200 {
		t.Fatalf("recovery key: %d %v", code, out)
	}
}
