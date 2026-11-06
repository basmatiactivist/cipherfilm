package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// demoEnv: an admin, a demo account that filled its library before it was listed (as deploy/demo/README.md says),
// and a third account that must not notice the demo at all.
func demoEnv(t *testing.T) (e *env, admin, demo, bob *client, item string) {
	t.Helper()
	t.Setenv("DEMO_ACCOUNTS", " Demo@X.org ,other@x.org")
	e = newEnv(t)
	admin, _ = e.setupAdmin("admin@x.org")
	demo, _ = e.acceptInvite(e.invite(admin, "demo@x.org"))
	bob, _ = e.acceptInvite(e.invite(admin, "bob@x.org"))
	// a listed account is refused from its first request: its photos go in before it is listed
	demoAccts := e.app.demo
	e.app.demo = nil
	item = e.readyItem(demo)
	e.app.demo = demoAccts
	return
}

func TestDemoAccountsSetting(t *testing.T) {
	got, err := demoAccounts(" Demo@X.org ,b@x.org  c@x.org")
	if err != nil || len(got) != 3 || !got["demo@x.org"] || !got["c@x.org"] {
		t.Fatalf("parse: %v %v", got, err)
	}
	if _, err := demoAccounts("demo@x.org,not-an-address"); err == nil {
		t.Fatal("a typo must stop the server, not leave the account writable")
	}
	if got, _ := demoAccounts(""); len(got) != 0 {
		t.Fatal("empty")
	}
}

func TestDemoAccountReadsAndSearchesButChangesNothing(t *testing.T) {
	e, admin, demo, bob, item := demoEnv(t)

	_, me := demo.do("GET", "/api/me", nil, false)
	if me["demo"] != true {
		t.Fatalf("me: %v", me)
	}
	for _, c := range []*client{admin, bob} {
		if _, me := c.do("GET", "/api/me", nil, false); me["demo"] != nil {
			t.Fatalf("not a demo account: %v", me)
		}
	}
	// reading works
	if code, out := demo.do("GET", "/api/items", nil, false); code != 200 || len(out["items"].([]any)) != 1 {
		t.Fatalf("list: %d %v", code, out)
	}
	if code, _ := demo.getRaw("/api/items/" + item + "/segments/0"); code != 200 {
		t.Fatalf("original: %d", code)
	}
	if code, _ := demo.postRaw("/api/items/thumbs", map[string]any{"item_ids": []string{item}}); code != 200 {
		t.Fatalf("thumbs: %d", code)
	}
	// search keeps its index
	if code, _ := demo.do("PUT", "/api/items/"+item+"/index", map[string]any{"data_enc": rb(300)}, true); code != 200 {
		t.Fatalf("index: %d", code)
	}
	// changes are refused, with a message the apps show as it is
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/items", map[string]any{"kind": "image", "size": 10, "segment_count": 1}},
		{"POST", "/api/items/trash", map[string]any{"item_ids": []string{item}}},
		{"POST", "/api/albums", albumBody()},
		{"POST", "/api/auth/password", map[string]any{}},
		{"DELETE", "/api/me", map[string]any{}},
		// names typed by one visitor would show to the next; wiping the index would break search for all of them
		{"PUT", "/api/me/blobs/people", map[string]any{"data_enc": rb(300), "version": 0}},
		{"DELETE", "/api/index", nil},
	} {
		if code, out := demo.do(c.method, c.path, c.body, true); code != 403 || out["error"] != demoRefused {
			t.Fatalf("%s %s: %d %v", c.method, c.path, code, out)
		}
	}
	if code, _ := demo.do("GET", "/api/trash", nil, false); code != 200 {
		t.Fatalf("trash list: %d", code)
	}
	if _, out := demo.do("GET", "/api/items", nil, false); len(out["items"].([]any)) != 1 {
		t.Fatal("the item was changed")
	}
	// nobody can set a new password for it through recovery either
	if code, out := e.client().do("POST", "/api/auth/recover/start", map[string]string{"email": "demo@x.org", "recovery_auth": rb(32)}, false); code != 403 || out["error"] != demoRefused {
		t.Fatalf("recover: %d %v", code, out)
	}
	// the other accounts work as before
	if code, _ := bob.do("POST", "/api/albums", albumBody(), true); code != 201 {
		t.Fatalf("bob album: %d", code)
	}
	e.newItem(admin, 10)
	if code, _ := demo.do("POST", "/api/auth/logout", nil, true); code != 200 {
		t.Fatalf("logout: %d", code)
	}
}

func TestDemoAccountIsNeverAnAdmin(t *testing.T) {
	t.Setenv("DEMO_ACCOUNTS", "admin@x.org")
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	if code, _ := admin.do("GET", "/api/admin/users", nil, false); code != 404 {
		t.Fatalf("admin read: %d", code)
	}
	if code, _ := admin.do("POST", "/api/admin/invites", map[string]string{"email": "x@x.org"}, true); code != 403 {
		t.Fatalf("invite: %d", code)
	}
}

var routeRe = regexp.MustCompile(`m\.HandleFunc\("([A-Z]+) (/[^"]*)"`)

// serverRoutes reads every route pattern from the source, so a route added later is in this test without anyone
// remembering to add it.
func serverRoutes(t *testing.T) []string {
	t.Helper()
	files, _ := filepath.Glob("*.go")
	var out []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range routeRe.FindAllStringSubmatch(string(b), -1) {
			out = append(out, m[1]+" "+m[2])
		}
	}
	if len(out) < 40 {
		t.Fatalf("found only %d routes: has the way routes are registered changed?", len(out))
	}
	return out
}

// Routes that need no sign-in, so the demo rule in auth() does not reach them; each is refused for a demo address
// by itself where that matters.
var demoPublic = map[string]string{
	"POST /api/setup":                  "only before the first account exists",
	"POST /api/auth/login":             "signing in is the point",
	"POST /api/auth/recover/start":     "refused for demo addresses (TestDemoAccountReadsAndSearchesButChangesNothing)",
	"POST /api/auth/recover/finish":    "needs a ticket from recover/start",
	"POST /api/invites/{token}/accept": "makes a new account, never changes one",
}

func TestDemoDefaultDeny(t *testing.T) {
	_, _, demo, _, _ := demoEnv(t)
	routes := serverRoutes(t)
	seen := map[string]bool{}
	for _, rt := range routes {
		seen[rt] = true
	}
	for rt := range demoAllowed {
		if !seen[rt] {
			t.Errorf("allow list names %q, which is no route", rt)
		}
	}
	for rt := range demoPublic {
		if !seen[rt] {
			t.Errorf("demoPublic names %q, which is no route", rt)
		}
	}
	fill := regexp.MustCompile(`\{[^}]+\}`)
	for _, rt := range routes {
		method, path, _ := strings.Cut(rt, " ")
		if method == "GET" || demoPublic[rt] != "" || rt == "POST /api/auth/logout" {
			continue
		}
		path = fill.ReplaceAllString(path, "zz0")
		code, out := demo.do(method, path, map[string]any{}, true)
		refused := code == 403 && out["error"] == demoRefused
		if demoAllowed[rt] && refused {
			t.Errorf("%s: allowed, but refused", rt)
		}
		if !demoAllowed[rt] && !refused {
			t.Errorf("%s: a demo account got %d %v; refuse it or add it to demoAllowed", rt, code, out)
		}
	}
}

func TestDemoAccountSeesOnlyItsOwnDevice(t *testing.T) {
	t.Setenv("DEMO_ACCOUNTS", "demo@x.org")
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	first, b := e.acceptInvite(e.invite(admin, "demo@x.org"))
	second := e.login("demo@x.org", b)
	for _, c := range []*client{first, second} {
		if code, out := c.do("GET", "/api/me/sessions", nil, false); code != 200 || len(out["sessions"].([]any)) != 1 {
			t.Fatalf("a visitor must see only its own device: %d %v", code, out)
		}
	}
	// an ordinary account still sees all of its devices
	other, ob := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.login("bob@x.org", ob)
	if _, out := other.do("GET", "/api/me/sessions", nil, false); len(out["sessions"].([]any)) != 2 {
		t.Fatalf("bob: %v", out)
	}
}
