package main

import (
	"net/http"
	"testing"
)

// told reports whether a device whose session ended hears it was signed out on purpose (it then deletes what it keeps)
// rather than only being asked to sign in again.
func told(t *testing.T, e *env, c *client) bool {
	t.Helper()
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/items", nil)
	resp, err := c.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("session still valid: %d", resp.StatusCode)
	}
	return resp.Header.Get("X-CF-Session") == "revoked"
}

// A password change, an admin turning the account off and a recovery end the other devices' sessions: they are told
// it was on purpose, like a sign-out from Account › Devices, so they delete their copy of the library and keys.
func TestEndedByPasswordDisableOrRecoveryCountsAsSignedOut(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")

	// password change: the other device is told, the changing one stays
	phone := e.login("admin@x.org", ab)
	nb := bundle()
	body := map[string]any{"current_auth": rb(32), "new_auth": nb["auth"], "new_kdf": nb["kdf"], "new_wrapped_master_pw": nb["wrapped_master_pw"]}
	if code, _ := admin.do("POST", "/api/auth/password", body, true); code != 403 {
		t.Fatalf("wrong password accepted: %d", code)
	}
	if code, _ := phone.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatal("a failed change ended the other session")
	}
	body["current_auth"] = ab["auth"]
	if code, out := admin.do("POST", "/api/auth/password", body, true); code != 200 {
		t.Fatalf("change: %d %v", code, out)
	}
	if !told(t, e, phone) {
		t.Fatal("other device not told after the password change")
	}
	if code, _ := admin.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatal("the changing session ended")
	}

	// an admin turns an account off: its devices are told
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	_, me := bob.do("GET", "/api/me", nil, false)
	bobID := me["user"].(map[string]any)["id"].(string)
	if code, _ := admin.do("PATCH", "/api/admin/users/"+bobID, map[string]string{"status": "disabled"}, true); code != 200 {
		t.Fatalf("disable: %d", code)
	}
	if !told(t, e, bob) {
		t.Fatal("disabled account's device not told")
	}

	// recovery: every device of the account is told
	_, cb := e.acceptInvite(e.invite(admin, "carol@x.org"))
	carolPhone := e.login("carol@x.org", cb)
	r := e.client()
	code, out := r.do("POST", "/api/auth/recover/start", map[string]string{"email": "carol@x.org", "recovery_auth": cb["recovery_verifier"].(string)}, false)
	if code != 200 {
		t.Fatalf("recover start: %d %v", code, out)
	}
	rb2 := bundle()
	fin := map[string]any{"ticket": out["ticket"], "new_auth": rb2["auth"], "new_kdf": rb2["kdf"], "new_wrapped_master_pw": rb2["wrapped_master_pw"],
		"new_wrapped_master_recovery": rb2["wrapped_master_recovery"], "new_recovery_verifier": rb2["recovery_verifier"]}
	if code, out := r.do("POST", "/api/auth/recover/finish", fin, false); code != 200 {
		t.Fatalf("recover finish: %d %v", code, out)
	}
	if !told(t, e, carolPhone) {
		t.Fatal("device not told after the recovery")
	}
}

// The console's disable-user signs the account's devices out as the admin area does: told it was on purpose.
func TestConsoleDisableCountsAsSignedOut(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	if _, err := e.cli("disable-user", "bob@x.org"); err != nil {
		t.Fatal(err)
	}
	if !told(t, e, bob) {
		t.Fatal("device of an account disabled from the console not told")
	}
}

// Deleting an account, in the admin area or on the console, signs its devices out on purpose too: they delete what
// they keep, as after self-deletion or disabling.
func TestDeletedAccountsDevicesAreTold(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	bobPhone := e.login("bob@x.org", bb)
	if code, out := admin.do("DELETE", "/api/admin/users/"+mustUserID(e, "bob@x.org"), nil, true); code != 200 {
		t.Fatalf("delete: %d %v", code, out)
	}
	if !told(t, e, bob) || !told(t, e, bobPhone) {
		t.Fatal("device of an account deleted in the admin area not told")
	}
	carol, _ := e.acceptInvite(e.invite(admin, "carol@x.org"))
	if _, err := e.cli("delete-user", "carol@x.org", "--yes"); err != nil {
		t.Fatal(err)
	}
	if !told(t, e, carol) {
		t.Fatal("device of an account deleted from the console not told")
	}
	// a delete that is refused (the last administrator) marks nothing
	if _, err := e.cli("delete-user", "admin@x.org", "--yes"); err == nil {
		t.Fatal("the last administrator was deleted")
	}
	if code, _ := admin.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatalf("the refused delete ended the admin's session: %d", code)
	}
}
