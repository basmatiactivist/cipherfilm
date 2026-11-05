package main

import (
	"bytes"
	"strings"
	"testing"
)

// cli runs a server command on the test server's data directory, as `docker compose exec app /app ...` would.
func (e *env) cli(args ...string) (string, error) {
	e.t.Helper()
	var out bytes.Buffer
	found, err := runCLI(e.app.dataDir, args[0], args[1:], &out)
	if !found {
		e.t.Fatalf("no command %q", args[0])
	}
	return out.String(), err
}

func TestServerCommands(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.readyItem(bob)

	if out, err := e.cli("list-users"); err != nil || !strings.Contains(out, "admin@x.org") || !strings.Contains(out, "bob@x.org") {
		t.Fatalf("list-users: %v %q", err, out)
	}
	if out, err := e.cli("status"); err != nil || !strings.Contains(out, "Accounts") {
		t.Fatalf("status: %v %q", err, out)
	}
	if _, err := e.cli("make-admin", "nobody@x.org"); err == nil {
		t.Fatal("unknown account accepted")
	}
	// the only admin can't lose the role, be locked or deleted
	for _, c := range [][]string{{"revoke-admin", "admin@x.org"}, {"disable-user", "admin@x.org"}, {"delete-user", "admin@x.org", "--yes"}} {
		if _, err := e.cli(c...); err == nil || !strings.Contains(err.Error(), "only active administrator") {
			t.Fatalf("%v: %v", c, err)
		}
	}
	if _, err := e.cli("make-admin", "BOB@x.org"); err != nil {
		t.Fatal(err)
	}
	if u, _ := e.app.userByEmail("bob@x.org"); u.Role != "admin" {
		t.Fatal("not admin")
	}
	if _, err := e.cli("revoke-admin", "bob@x.org"); err != nil {
		t.Fatal(err)
	}

	if _, err := e.cli("set-quota", "bob@x.org", "1.5"); err != nil {
		t.Fatal(err)
	}
	var q int64
	e.app.db.QueryRow(`SELECT quota_bytes FROM users WHERE email='bob@x.org'`).Scan(&q)
	if q != 1_500_000_000 {
		t.Fatalf("quota %d", q)
	}
	if _, err := e.cli("set-quota", "bob@x.org", "lots"); err == nil {
		t.Fatal("bad size accepted")
	}

	if _, err := e.cli("allow-explicit", "bob@x.org"); err != nil {
		t.Fatal(err)
	}
	if _, me := bob.do("GET", "/api/me", nil, false); !me["user"].(map[string]any)["nsfw"].(bool) {
		t.Fatal("explicit search not allowed")
	}

	if out, _ := e.cli("list-sessions", "bob@x.org"); strings.Count(out, "bob@x.org") != 1 {
		t.Fatalf("sessions: %q", out)
	}
	if _, err := e.cli("sign-out", "bob@x.org", "--wipe"); err != nil {
		t.Fatal(err)
	}
	if code, _ := bob.do("GET", "/api/me", nil, false); code != 401 {
		t.Fatalf("still signed in: %d", code)
	}

	if _, err := e.cli("disable-user", "bob@x.org"); err != nil {
		t.Fatal(err)
	}
	if u, _ := e.app.userByEmail("bob@x.org"); u.Status != "disabled" {
		t.Fatal("not disabled")
	}
	if _, err := e.cli("enable-user", "bob@x.org"); err != nil {
		t.Fatal(err)
	}

	// deleting needs --yes
	if _, err := e.cli("delete-user", "bob@x.org"); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("delete without --yes: %v", err)
	}
	if _, err := e.app.userByEmail("bob@x.org"); err != nil {
		t.Fatal("deleted without --yes")
	}
	if out, err := e.cli("delete-user", "bob@x.org", "--yes"); err != nil || !strings.Contains(out, "1 photos") {
		t.Fatalf("delete: %v %q", err, out)
	}
	if _, err := e.app.userByEmail("bob@x.org"); err == nil {
		t.Fatal("still there")
	}

	// an invite from the console works like one from Admin › Users
	out, err := e.cli("invite", "carol@x.org", "--url", "https://photos.example.org")
	if err != nil {
		t.Fatal(err)
	}
	i := strings.Index(out, "https://photos.example.org/invite/")
	if i < 0 {
		t.Fatalf("invite: %q", out)
	}
	tok := strings.Fields(out[i+len("https://photos.example.org/invite/"):])[0]
	if code, _ := e.client().do("GET", "/api/invites/"+tok, nil, false); code != 200 {
		t.Fatalf("invite token: %d", code)
	}
	if _, err := e.cli("invite", "admin@x.org"); err == nil {
		t.Fatal("invite for an existing account")
	}

	if out, _ := e.cli("reset-password", "admin@x.org"); !strings.Contains(out, "recovery key") {
		t.Fatalf("reset-password: %q", out)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE actor=?`, consoleActor).Scan(&n)
	if n < 8 {
		t.Fatalf("audit entries: %d", n)
	}
	var help bytes.Buffer
	printHelp(&help)
	for _, c := range cliCmds {
		if !strings.Contains(help.String(), c.name) {
			t.Fatalf("help lacks %s", c.name)
		}
	}
}
