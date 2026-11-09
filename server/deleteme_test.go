package main

import (
	"net/http"
	"os"
	"testing"
)

func TestDeleteOwnAccount(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	bob, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	phone := e.client()
	if code, _ := phone.do("POST", "/api/auth/login", map[string]string{"email": "bob@x.org", "auth": bb["auth"].(string)}, false); code != 200 {
		t.Fatal("second session")
	}
	id := e.newItem(bob, 10)
	bob.put("/api/items/"+id+"/segments/0", randBytes(int(cipherLen(10))))
	bob.do("POST", "/api/items/"+id+"/finalize", finalizeBody(), true)
	bob.do("POST", "/api/albums", map[string]any{"name_enc": rb(40)}, true)

	// the proof and the CSRF token are both needed
	if code, _ := bob.do("DELETE", "/api/me", map[string]any{"current_auth": bb["auth"]}, false); code != 403 {
		t.Fatalf("without csrf: %d", code)
	}
	if code, _ := bob.do("DELETE", "/api/me", map[string]any{"current_auth": rb(32)}, true); code != 403 {
		t.Fatalf("wrong password: %d", code)
	}
	if code, _ := bob.do("DELETE", "/api/me", map[string]any{}, true); code != 403 {
		t.Fatalf("no password: %d", code)
	}
	if code, out := bob.do("DELETE", "/api/me", map[string]any{"current_auth": bb["auth"]}, true); code != 200 {
		t.Fatalf("delete: %d %v", code, out)
	}
	if _, err := os.Stat(e.app.itemDir(id)); !os.IsNotExist(err) {
		t.Fatal("blobs left on disk")
	}
	var n int
	e.app.db.QueryRow(`SELECT (SELECT COUNT(*) FROM items)+(SELECT COUNT(*) FROM albums)+(SELECT COUNT(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='bob@x.org')+(SELECT COUNT(*) FROM users WHERE email='bob@x.org')`).Scan(&n)
	if n != 0 {
		t.Fatalf("rows left: %d", n)
	}
	if code, _ := bob.do("GET", "/api/me", nil, false); code != 401 {
		t.Fatalf("session survived: %d", code)
	}
	// the other device is told it was signed out on purpose, so it wipes what it keeps
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/me", nil)
	resp, err := phone.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 || resp.Header.Get("X-CF-Session") != "revoked" {
		t.Fatalf("other device: %d %q", resp.StatusCode, resp.Header.Get("X-CF-Session"))
	}
	if code, _ := e.client().do("POST", "/api/auth/login", map[string]string{"email": "bob@x.org", "auth": bb["auth"].(string)}, false); code != 401 {
		t.Fatal("deleted account can sign in")
	}
	var audit int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action='deleted own account' AND target='bob@x.org'`).Scan(&audit)
	if audit != 1 {
		t.Fatalf("audit entries: %d", audit)
	}

	// the only administrator can't, until there is another one
	if code, out := admin.do("DELETE", "/api/me", map[string]any{"current_auth": ab["auth"]}, true); code != 409 {
		t.Fatalf("last admin deleted: %d %v", code, out)
	}
	if code, _ := admin.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatal("last admin was signed out")
	}
	_, cb := e.acceptInvite(e.invite(admin, "carol@x.org"))
	_ = cb
	var carolID string
	e.app.db.QueryRow(`SELECT id FROM users WHERE email='carol@x.org'`).Scan(&carolID)
	if code, _ := admin.do("PATCH", "/api/admin/users/"+carolID, map[string]string{"role": "admin"}, true); code != 200 {
		t.Fatal("promote")
	}
	if code, out := admin.do("DELETE", "/api/me", map[string]any{"current_auth": ab["auth"]}, true); code != 200 {
		t.Fatalf("admin with a successor: %d %v", code, out)
	}
}

// After a deletion the server keeps the e-mail address only in the one activity-log entry of the deletion: not in
// the invite it came with, not in earlier entries, and none of its device entries.
func TestDeletedAccountLeavesOnlyTheDeletionEntry(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	_, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	bob := e.login("bob@x.org", bb)
	e.acceptInvite(e.invite(admin, "carol@x.org"))
	e.app.audit("bob@x.org", "signed out a device", "bob@x.org", "Bob's phone")
	e.app.audit("admin@x.org", "storage limit changed", "bob@x.org", "1000")
	e.app.audit("carol@x.org", "signed out a device", "carol@x.org", "Carol's phone")
	if code, out := bob.do("DELETE", "/api/me", map[string]any{"current_auth": bb["auth"]}, true); code != 200 {
		t.Fatalf("delete: %d %v", code, out)
	}
	carol, _ := e.app.userByEmail("carol@x.org")
	if code, _ := admin.do("DELETE", "/api/admin/users/"+carol.ID, nil, true); code != 200 {
		t.Fatalf("admin delete: %d", code)
	}
	for _, email := range []string{"bob@x.org", "carol@x.org"} {
		var inv, rows int
		e.app.db.QueryRow(`SELECT COUNT(*) FROM invites WHERE email=?`, email).Scan(&inv)
		e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE actor=?1 OR target=?1 OR detail LIKE '%'||?1||'%'`, email).Scan(&rows)
		if inv != 0 || rows != 1 {
			t.Fatalf("%s: %d invites, %d activity entries left", email, inv, rows)
		}
	}
	var labels int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE detail LIKE '%phone%'`).Scan(&labels)
	if labels != 0 {
		t.Fatalf("device labels left: %d", labels)
	}
	// the administrator's own entries stay, with the deleted person's name taken out
	var kept int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action='storage limit changed' AND target='a deleted account'`).Scan(&kept)
	if kept != 1 {
		t.Fatalf("admin entry about the deleted account: %d", kept)
	}
}
