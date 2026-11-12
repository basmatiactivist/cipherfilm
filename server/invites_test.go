package main

import (
	"net/url"
	"regexp"
	"testing"
)

func (e *env) inviteWorks(tok string) bool {
	e.t.Helper()
	code, _ := e.client().do("GET", "/api/invites/"+tok, nil, false)
	if code == 200 {
		return true
	}
	code, _ = e.client().do("POST", "/api/invites/"+tok+"/accept", bundle(), false)
	return code == 201
}

// An invite made from a session that is signed out (by the person, or because the password was changed on another
// device), or by an administrator who is demoted, disabled or deleted since, stops working. One made on the server
// console, and one made from the session that changed the password, keep working.
func TestInvitesEndWithTheirCreatorsAuthority(t *testing.T) {
	e := newEnv(t)
	owner, ab := e.setupAdmin("admin@x.org")
	stolen := e.login("admin@x.org", ab)
	fromStolen := e.invite(stolen, "eve@x.org")
	fromOwner := e.invite(owner, "mum@x.org")
	if code, out := owner.do("POST", "/api/auth/password", map[string]any{"current_auth": ab["auth"], "new_auth": rb(32),
		"new_kdf": ab["kdf"], "new_wrapped_master_pw": rb(wrappedLen)}, true); code != 200 {
		t.Fatalf("password change: %d %v", code, out)
	}
	if e.inviteWorks(fromStolen) {
		t.Fatal("an invite from a session the password change ended still works")
	}
	if !e.inviteWorks(fromOwner) {
		t.Fatal("the changing session's own invite stopped working")
	}

	// a co-administrator's invites end when they are demoted, disabled or deleted
	for _, how := range []string{"demote", "disable", "delete"} {
		e2 := newEnv(t)
		admin, _ := e2.setupAdmin("admin@x.org")
		co, _ := e2.acceptInvite(e2.invite(admin, "co@x.org"))
		uid := mustUserID(e2, "co@x.org")
		if code, out := admin.do("PATCH", "/api/admin/users/"+uid, map[string]any{"role": "admin"}, true); code != 200 {
			t.Fatalf("promote: %d %v", code, out)
		}
		tok := e2.invite(co, "guest@x.org")
		switch how {
		case "demote":
			admin.do("PATCH", "/api/admin/users/"+uid, map[string]any{"role": "user"}, true)
		case "disable":
			admin.do("PATCH", "/api/admin/users/"+uid, map[string]any{"status": "disabled"}, true)
		case "delete":
			admin.do("DELETE", "/api/admin/users/"+uid, nil, true)
		}
		if e2.inviteWorks(tok) {
			t.Fatalf("%s: the invite still works", how)
		}
		if _, out := admin.do("GET", "/api/admin/users", nil, false); len(out["invites"].([]any)) != 0 {
			t.Fatalf("%s: a dead invite is listed: %v", how, out["invites"])
		}
	}

	// the server console's invites don't depend on any account
	out, err := e.cli("invite", "gran@x.org")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`/invite/(\S+)`).FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("no link in %q", out)
	}
	tok, _ := url.PathUnescape(m[1])
	if !e.inviteWorks(tok) {
		t.Fatal("a console invite stopped working")
	}
}

// Signing a device out from the device list ends the invites made from it; the others stay.
func TestSigningADeviceOutEndsItsInvites(t *testing.T) {
	e := newEnv(t)
	owner, ab := e.setupAdmin("admin@x.org")
	lost := e.login("admin@x.org", ab)
	third := e.login("admin@x.org", ab)
	fromLost := e.invite(lost, "a@x.org")
	fromThird := e.invite(third, "b@x.org")
	fromOwner := e.invite(owner, "c@x.org")
	var lostPub string
	for _, s := range sessionList(t, lost) {
		if s["current"] == true {
			lostPub = s["id"].(string)
		}
	}
	if code, _ := owner.do("DELETE", "/api/me/sessions/"+lostPub, nil, true); code != 200 {
		t.Fatalf("sign out: %d", code)
	}
	if e.inviteWorks(fromLost) {
		t.Fatal("the signed-out device's invite still works")
	}
	if code, _ := owner.do("POST", "/api/me/sessions/end-others", nil, true); code != 200 {
		t.Fatalf("end others: %d", code)
	}
	if e.inviteWorks(fromThird) {
		t.Fatal("an invite of a device signed out with the others still works")
	}
	if !e.inviteWorks(fromOwner) {
		t.Fatal("this device's own invite stopped working")
	}
}
