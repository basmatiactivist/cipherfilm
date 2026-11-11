package main

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestAdminRevokeInviteAndLastLogin(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	tok := e.invite(admin, "bob@x.org")
	code, out := admin.do("GET", "/api/admin/users", nil, false)
	if code != 200 {
		t.Fatalf("list: %d", code)
	}
	invs := out["invites"].([]any)
	if len(invs) != 1 {
		t.Fatalf("want 1 open invite, got %d", len(invs))
	}
	id := invs[0].(map[string]any)["id"].(string)
	// the signed-in admin has a recorded last login
	if last := out["users"].([]any)[0].(map[string]any)["last_login_at"].(float64); last == 0 {
		t.Fatal("last_login_at not recorded")
	}
	if code, _ := admin.do("DELETE", "/api/admin/invites/"+id, nil, true); code != 200 {
		t.Fatalf("revoke: %d", code)
	}
	if code, _ := e.client().do("POST", "/api/invites/"+tok+"/accept", bundle(), false); code == 201 {
		t.Fatal("a revoked invite still worked")
	}
	if code, _ := admin.do("DELETE", "/api/admin/invites/"+id, nil, true); code != 404 {
		t.Fatalf("second revoke should be 404, got %d", code)
	}
	if code, _ := e.client().do("DELETE", "/api/admin/invites/"+id, nil, false); code == 200 {
		t.Fatal("anonymous revoke allowed")
	}
}

func TestInviteLimitDefaultLimitRolesAuditAndStatus(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	quotaOf := func(email string) float64 {
		_, out := admin.do("GET", "/api/admin/users", nil, false)
		for _, x := range out["users"].([]any) {
			if m := x.(map[string]any); m["email"] == email {
				return m["quota_bytes"].(float64)
			}
		}
		t.Fatalf("%s not listed", email)
		return -1
	}
	// a limit chosen in the invite wins over the default
	if code, out := admin.do("POST", "/api/admin/invites", map[string]any{"email": "bob@x.org", "quota_bytes": int64(5 << 30)}, true); code != 201 {
		t.Fatalf("invite with limit: %d %v", code, out)
	} else if code, _ := e.client().do("POST", "/api/invites/"+out["token"].(string)+"/accept", bundle(), false); code != 201 {
		t.Fatalf("accept: %d", code)
	}
	if got := quotaOf("bob@x.org"); got != float64(5<<30) {
		t.Fatalf("invite limit not applied: %v", got)
	}
	// changing the default affects later invites only
	if code, _ := admin.do("PATCH", "/api/admin/settings", map[string]any{"default_quota_bytes": int64(7 << 30)}, true); code != 200 {
		t.Fatalf("settings: %d", code)
	}
	tok := e.invite(admin, "carol@x.org")
	e.client().do("POST", "/api/invites/"+tok+"/accept", bundle(), false)
	if got := quotaOf("carol@x.org"); got != float64(7<<30) {
		t.Fatalf("default limit not applied: %v", got)
	}
	if got := quotaOf("bob@x.org"); got != float64(5<<30) {
		t.Fatalf("existing limit changed: %v", got)
	}
	if code, _ := admin.do("PATCH", "/api/admin/settings", map[string]any{"default_quota_bytes": int64(-1)}, true); code != 400 {
		t.Fatalf("negative default accepted: %d", code)
	}
	// roles: promote, never change yourself
	_, out := admin.do("GET", "/api/admin/users", nil, false)
	var bobID, adminID string
	for _, x := range out["users"].([]any) {
		m := x.(map[string]any)
		if m["email"] == "bob@x.org" {
			bobID = m["id"].(string)
		}
		if m["email"] == "admin@x.org" {
			adminID = m["id"].(string)
		}
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"role": "admin"}, true); code != 200 {
		t.Fatalf("promote: %d", code)
	}
	if got := quotaOf("bob@x.org"); got != 0 {
		t.Fatalf("an admin should have no limit, got %v", got)
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+adminID, map[string]any{"role": "user"}, true); code != 400 {
		t.Fatalf("self-demotion allowed: %d", code)
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"role": "superuser"}, true); code != 400 {
		t.Fatalf("invalid role accepted: %d", code)
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+bobID, map[string]any{"role": "user"}, true); code != 200 {
		t.Fatalf("demote: %d", code)
	}
	if got := quotaOf("bob@x.org"); got != float64(7<<30) {
		t.Fatalf("demoted user should get the default limit, got %v", got)
	}
	// audit trail and status
	code, out := admin.do("GET", "/api/admin/audit", nil, false)
	if code != 200 || len(out["entries"].([]any)) < 5 {
		t.Fatalf("audit: %d %v", code, out)
	}
	code, out = admin.do("GET", "/api/admin/status", nil, false)
	if code != 200 || out["disk_total_bytes"].(float64) <= 0 {
		t.Fatalf("status: %d %v", code, out)
	}
	// non-admins get none of it
	bob := e.client()
	for _, p := range []string{"/api/admin/audit", "/api/admin/status"} {
		if code, _ := bob.do("GET", p, nil, false); code == 200 {
			t.Fatalf("anonymous %s allowed", p)
		}
	}
}

func TestMutualAdminChangesNeverLeaveZeroAdmins(t *testing.T) {
	for _, action := range []string{"demote", "disable", "delete"} {
		e := newEnv(t)
		a, _ := e.setupAdmin("a@x.org")
		bTok := e.invite(a, "b@x.org")
		b, _ := e.acceptInvite(bTok)
		_, out := a.do("GET", "/api/admin/users", nil, false)
		ids := map[string]string{}
		for _, x := range out["users"].([]any) {
			m := x.(map[string]any)
			ids[m["email"].(string)] = m["id"].(string)
		}
		if code, _ := a.do("PATCH", "/api/admin/users/"+ids["b@x.org"], map[string]any{"role": "admin"}, true); code != 200 {
			t.Fatalf("promote: %d", code)
		}
		fire := func(c *client, target string) int {
			switch action {
			case "demote":
				code, _ := c.do("PATCH", "/api/admin/users/"+target, map[string]any{"role": "user"}, true)
				return code
			case "disable":
				code, _ := c.do("PATCH", "/api/admin/users/"+target, map[string]any{"status": "disabled"}, true)
				return code
			}
			code, _ := c.do("DELETE", "/api/admin/users/"+target, nil, true)
			return code
		}
		var wg sync.WaitGroup
		start := make(chan struct{})
		codes := make([]int, 2)
		wg.Add(2)
		go func() { defer wg.Done(); <-start; codes[0] = fire(a, ids["b@x.org"]) }()
		go func() { defer wg.Done(); <-start; codes[1] = fire(b, ids["a@x.org"]) }()
		close(start)
		wg.Wait()
		var n int
		e.app.db.QueryRow(`SELECT COUNT(*) FROM users WHERE role='admin' AND status='active'`).Scan(&n)
		if n < 1 {
			t.Fatalf("%s: no active administrator left (codes %v)", action, codes)
		}
		if codes[0] == 200 && codes[1] == 200 {
			t.Fatalf("%s: both admins succeeded against each other", action)
		}
	}
}

func TestConcurrentInviteAcceptsDoNotStallTheServer(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	var toks []string
	for i := 0; i < 8; i++ {
		toks = append(toks, e.invite(admin, fmt.Sprintf("u%d@x.org", i)))
	}
	start := time.Now()
	var wg sync.WaitGroup
	codes := make([]int, len(toks))
	for i, tok := range toks {
		wg.Add(1)
		go func(i int, tok string) {
			defer wg.Done()
			codes[i], _ = e.client().do("POST", "/api/invites/"+tok+"/accept", bundle(), false)
		}(i, tok)
	}
	wg.Wait()
	for i, c := range codes {
		if c != 201 {
			t.Fatalf("accept %d: %d", i, c)
		}
	}
	if d := time.Since(start); d > 4*time.Second {
		t.Fatalf("8 concurrent invite accepts took %v: the connection pool is starving", d)
	}
}

func TestExplicitQuotaSurvivesARoleChangeInTheSameRequest(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	e.acceptInvite(e.invite(admin, "bob@x.org"))
	_, out := admin.do("GET", "/api/admin/users", nil, false)
	var id string
	for _, x := range out["users"].([]any) {
		if m := x.(map[string]any); m["email"] == "bob@x.org" {
			id = m["id"].(string)
		}
	}
	admin.do("PATCH", "/api/admin/users/"+id, map[string]any{"role": "admin"}, true)
	if code, _ := admin.do("PATCH", "/api/admin/users/"+id, map[string]any{"role": "user", "quota_bytes": int64(3 << 30)}, true); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	var q int64
	e.app.db.QueryRow(`SELECT quota_bytes FROM users WHERE id=?`, id).Scan(&q)
	if q != 3<<30 {
		t.Fatalf("explicit limit was overwritten: %d", q)
	}
}

// The Android and Mac apps show Administration only to admins, but that is a hint: every admin request the apps make
// is refused by the server for a regular user and for the public demo login, even one listed as an admin by mistake,
// and refused requests change nothing.
func TestEveryAdminRouteTheAppsUseRefusesNonAdmins(t *testing.T) {
	e, admin, demo, bob, _ := demoEnv(t)
	ids := map[string]string{}
	_, out := admin.do("GET", "/api/admin/users", nil, false)
	for _, u := range out["users"].([]any) {
		m := u.(map[string]any)
		ids[m["email"].(string)] = m["id"].(string)
	}
	// the demo login made an admin: still never administers
	e.app.db.Exec(`UPDATE users SET role='admin' WHERE id=?`, ids["demo@x.org"])
	admin.do("POST", "/api/admin/invites", map[string]any{"email": "open@x.org"}, true)
	_, out = admin.do("GET", "/api/admin/users", nil, false)
	inv := out["invites"].([]any)[0].(map[string]any)["id"].(string)
	target := ids["bob@x.org"]
	routes := [][3]any{
		{"GET", "/api/admin/users", nil}, {"GET", "/api/admin/audit", nil}, {"GET", "/api/admin/status", nil},
		{"POST", "/api/admin/invites", map[string]any{"email": "x@x.org"}},
		{"DELETE", "/api/admin/invites/" + inv, nil},
		{"PATCH", "/api/admin/settings", map[string]any{"default_quota_bytes": 1}},
		{"PATCH", "/api/admin/users/" + ids["admin@x.org"], map[string]any{"status": "disabled"}},
		{"PATCH", "/api/admin/users/" + ids["admin@x.org"], map[string]any{"role": "user"}},
		{"PATCH", "/api/admin/users/" + target, map[string]any{"nsfw": true}},
		{"PATCH", "/api/admin/users/" + target, map[string]any{"quota_bytes": 0}},
		{"DELETE", "/api/admin/users/" + ids["admin@x.org"] + "/2fa", nil},
		{"DELETE", "/api/admin/users/" + ids["admin@x.org"], nil},
	}
	for _, c := range []struct {
		name string
		cl   *client
	}{{"regular user", bob}, {"demo listed as admin", demo}} {
		for _, r := range routes {
			code, _ := c.cl.do(r[0].(string), r[1].(string), r[2], true)
			if code != 404 && code != 403 {
				t.Errorf("%s: %s %s answered %d", c.name, r[0], r[1], code)
			}
		}
	}
	// nothing changed: the admin is still an active admin, bob's limit and the invite are as they were
	_, out = admin.do("GET", "/api/admin/users", nil, false)
	if len(out["invites"].([]any)) != 1 || out["default_quota_bytes"].(float64) == 1 {
		t.Fatalf("a refused request changed something: %v", out)
	}
	for _, u := range out["users"].([]any) {
		m := u.(map[string]any)
		if m["email"] == "admin@x.org" && (m["role"] != "admin" || m["status"] != "active") {
			t.Fatalf("admin changed: %v", m)
		}
		if m["email"] == "bob@x.org" && (m["nsfw"] != false || m["quota_bytes"].(float64) == 0) {
			t.Fatalf("bob changed: %v", m)
		}
	}
}
