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

	// and they stay ended when the administrator is enabled or promoted again, in the admin area or on the console
	for _, how := range []string{"demote", "disable", "console-demote", "console-disable"} {
		e2 := newEnv(t)
		admin, _ := e2.setupAdmin("admin@x.org")
		co, _ := e2.acceptInvite(e2.invite(admin, "co@x.org"))
		uid := mustUserID(e2, "co@x.org")
		if code, out := admin.do("PATCH", "/api/admin/users/"+uid, map[string]any{"role": "admin"}, true); code != 200 {
			t.Fatalf("promote: %d %v", code, out)
		}
		tok := e2.invite(co, "guest@x.org")
		var err error
		switch how {
		case "demote":
			admin.do("PATCH", "/api/admin/users/"+uid, map[string]any{"role": "user"}, true)
			admin.do("PATCH", "/api/admin/users/"+uid, map[string]any{"role": "admin"}, true)
		case "disable":
			admin.do("PATCH", "/api/admin/users/"+uid, map[string]any{"status": "disabled"}, true)
			admin.do("PATCH", "/api/admin/users/"+uid, map[string]any{"status": "active"}, true)
		case "console-demote":
			if _, err = e2.cli("revoke-admin", "co@x.org"); err == nil {
				_, err = e2.cli("make-admin", "co@x.org")
			}
		case "console-disable":
			if _, err = e2.cli("disable-user", "co@x.org"); err == nil {
				_, err = e2.cli("enable-user", "co@x.org")
			}
		}
		if err != nil {
			t.Fatalf("%s: %v", how, err)
		}
		if u, _ := e2.app.userByID(uid); u == nil || u.Role != "admin" || u.Status != "active" {
			t.Fatalf("%s: not back as an active administrator", how)
		}
		if e2.inviteWorks(tok) {
			t.Fatalf("%s and back: the old invite works again", how)
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

// An invite also ends with its session when that session signs itself out, is pushed out by the limit on sessions per
// account, or reaches the end of its lifetime.
func TestInvitesEndWithTheirSessionHoweverItEnds(t *testing.T) {
	e := newEnv(t)
	owner, ab := e.setupAdmin("admin@x.org")
	fromOwner := e.invite(owner, "keep@x.org")

	// signed out by itself: gone from the device list, so nobody could sign it out there any more
	stolen := e.login("admin@x.org", ab)
	tok := e.invite(stolen, "eve@x.org")
	if code, _ := stolen.do("POST", "/api/auth/logout", nil, true); code != 200 {
		t.Fatalf("logout: %d", code)
	}
	if e.inviteWorks(tok) {
		t.Fatal("the invite of a session that signed itself out still works")
	}

	// pushed out by sessionsMax newer sign-ins (on a server of its own: the others may be pushed out too)
	{
		e2 := newEnv(t)
		_, ab2 := e2.setupAdmin("admin@x.org")
		old := e2.login("admin@x.org", ab2)
		tok := e2.invite(old, "eve2@x.org")
		var pub string
		e2.app.db.QueryRow(`SELECT created_session FROM invites WHERE email='eve2@x.org'`).Scan(&pub)
		now := e2.app.now().Unix()
		e2.app.db.Exec(`UPDATE sessions SET last_seen=?, created_at=? WHERE pub=?`, now-31*24*3600, now-40*24*3600, pub)
		for range sessionsMax {
			e2.login("admin@x.org", ab2)
		}
		var n int
		e2.app.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE pub=?`, pub).Scan(&n)
		if pub == "" || n != 0 {
			t.Fatal("the session unused longest was not pushed out")
		}
		if e2.inviteWorks(tok) {
			t.Fatal("the invite of a session pushed out by the limit still works")
		}
	}

	// at the end of its lifetime (a year after sign-in), found by its own next request or by the next sign-in
	for _, found := range []string{"request", "sign-in"} {
		yearOld := e.login("admin@x.org", ab)
		tok = e.invite(yearOld, "eve-"+found+"@x.org")
		e.app.db.Exec(`UPDATE sessions SET expires_at=? WHERE pub IN (SELECT created_session FROM invites WHERE email=?)`,
			e.app.now().Unix()-1, "eve-"+found+"@x.org")
		if found == "request" {
			yearOld.do("GET", "/api/me", nil, false)
		} else {
			e.login("admin@x.org", ab)
		}
		if e.inviteWorks(tok) {
			t.Fatalf("the invite of a session that ended at its lifetime (found by a %s) still works", found)
		}
	}

	// and a session row removed some other way takes its invites' validity with it
	other := e.login("admin@x.org", ab)
	tok = e.invite(other, "eve3@x.org")
	e.app.db.Exec(`DELETE FROM sessions WHERE pub IN (SELECT created_session FROM invites WHERE email='eve3@x.org')`)
	if e.inviteWorks(tok) {
		t.Fatal("an invite whose session is gone still works")
	}
	if !e.inviteWorks(fromOwner) {
		t.Fatal("the invite of a session that is still signed in stopped working")
	}
}
