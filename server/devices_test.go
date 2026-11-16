package main

import (
	"net/http"
	"testing"
	"time"
)

// at moves the server's clock to this many days after now.
func (e *env) at(days float64) {
	d := time.Duration(days * float64(24*time.Hour))
	base := time.Now()
	e.app.now = func() time.Time { return base.Add(d) }
}

func revokedHeader(t *testing.T, e *env, c *client) string {
	t.Helper()
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/items", nil)
	resp, err := c.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.Header.Get("X-CF-Session")
}

func sessionByID(l []map[string]any, id string) map[string]any {
	for _, s := range l {
		if s["id"] == id {
			return s
		}
	}
	return nil
}

func TestUnusedDevicesAreSignedOutAfterTheAccountsChoice(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	phone := e.login("admin@x.org", ab)
	bob, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	bobPhone := e.login("bob@x.org", bb)
	_, pm := phone.do("GET", "/api/me", nil, false)
	if _, me := admin.do("GET", "/api/me", nil, false); me["idle_days"].(float64) != 30 {
		t.Fatalf("default: %v", me["idle_days"])
	}
	for _, d := range []any{0, 1, 10, 31, 365, -7, "7"} {
		if code, _ := admin.do("PUT", "/api/me/device-idle", map[string]any{"days": d}, true); code != 400 {
			t.Fatalf("%v days accepted: %d", d, code)
		}
	}
	if code, _ := admin.do("PUT", "/api/me/device-idle", map[string]any{"days": 7}, false); code != 403 {
		t.Fatalf("without csrf: %d", code)
	}
	if code, out := admin.do("PUT", "/api/me/device-idle", map[string]any{"days": 7}, true); code != 200 || out["idle_days"].(float64) != 7 {
		t.Fatalf("set 7: %d %v", code, out)
	}
	// day 5: this browser and bob's are used, the phone isn't
	e.at(5)
	admin.do("GET", "/api/me", nil, false)
	bob.do("GET", "/api/me", nil, false)
	// day 8: the phone, unused for 8 days, is shown as unused and signed out when it comes back
	e.at(8)
	l := sessionList(t, admin)
	if p := sessionByID(l, pm["session_id"].(string)); p == nil || p["unused"] != true {
		t.Fatalf("phone not unused: %v", l)
	}
	for _, s := range l {
		if s["current"] == true && s["unused"] != false {
			t.Fatal("this device shown as unused")
		}
	}
	if _, out := admin.do("GET", "/api/me/sessions", nil, false); out["idle_days"].(float64) != 7 {
		t.Fatalf("list idle_days: %v", out["idle_days"])
	}
	if h := revokedHeader(t, e, phone); h != "revoked" {
		t.Fatalf("unused device not told it was signed out: %q", h)
	}
	if len(sessionList(t, admin)) != 1 {
		t.Fatal("ended device still listed")
	}
	// bob's account keeps 30 days: his phone, unused for 8 days, is still in
	if code, _ := bobPhone.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatalf("another account's choice applied: %d", code)
	}
	// raising the limit again keeps a device in that is unused for longer than the old one
	admin.do("PUT", "/api/me/device-idle", map[string]any{"days": 30}, true)
	p2 := e.login("admin@x.org", ab)
	admin.do("PUT", "/api/me/device-idle", map[string]any{"days": 14}, true)
	e.at(18)
	admin.do("GET", "/api/me", nil, false)
	e.at(30)
	if code, _ := p2.do("GET", "/api/me", nil, false); code != 401 {
		t.Fatalf("14 days: unused for 22 days still in: %d", code)
	}
	if code, _ := admin.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatalf("used 12 days ago: %d", code)
	}
}

func TestDefaultIdleEndIsARevocation(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	phone := e.login("admin@x.org", ab)
	tablet := e.login("admin@x.org", ab)
	e.at(31)
	if h := revokedHeader(t, e, phone); h != "revoked" {
		t.Fatalf("30 days unused: %q", h)
	}
	// a sign-in sweeps the ended sessions: the tablet, unused too, is remembered as signed out as well
	e.login("admin@x.org", ab)
	if h := revokedHeader(t, e, tablet); h != "revoked" {
		t.Fatalf("swept unused device: %q", h)
	}
	// a session that reached the year's end is not one: it only signs in again
	e.at(0)
	old := e.login("admin@x.org", ab)
	_, om := old.do("GET", "/api/me", nil, false)
	now := time.Now().Unix()
	e.app.db.Exec(`UPDATE sessions SET created_at=?, last_seen=?, expires_at=? WHERE pub=?`, now-int64(sessionAbs.Seconds())-10, now-5, now-10, om["session_id"])
	if h := revokedHeader(t, e, old); h != "" {
		t.Fatalf("a year's end marked as revoked: %q", h)
	}
	_ = admin
}

func TestSignOutUnusedDevicesNow(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	recent := e.login("admin@x.org", ab)
	unused := e.login("admin@x.org", ab)
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	_, bm := bob.do("GET", "/api/me", nil, false)
	admin.do("PUT", "/api/me/device-idle", map[string]any{"days": 14}, true)
	e.at(10)
	recent.do("GET", "/api/me", nil, false)
	admin.do("GET", "/api/me", nil, false)
	// bob's session is old too, but it isn't this account's
	e.at(20)
	if code, _ := admin.do("POST", "/api/me/sessions/end-unused", nil, false); code != 403 {
		t.Fatalf("without csrf: %d", code)
	}
	if code, out := admin.do("POST", "/api/me/sessions/end-unused", nil, true); code != 200 || out["ended"].(float64) != 1 {
		t.Fatalf("end unused: %d %v", code, out)
	}
	if h := revokedHeader(t, e, unused); h != "revoked" {
		t.Fatalf("not told: %q", h)
	}
	if code, _ := recent.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatalf("used 10 days ago: %d", code)
	}
	if code, _ := admin.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatal("this device ended")
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE pub=?`, bm["session_id"]).Scan(&n)
	if n != 1 {
		t.Fatal("another account's device ended")
	}
	if _, out := admin.do("POST", "/api/me/sessions/end-unused", nil, true); out["ended"].(float64) != 0 {
		t.Fatalf("again: %v", out)
	}
	if code, _ := e.client().do("POST", "/api/me/sessions/end-unused", nil, true); code != 401 {
		t.Fatalf("signed out: %d", code)
	}
}

func TestUnusedIndexerGivesWay(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	phone := e.login("admin@x.org", ab)
	phone.do("PUT", "/api/me/indexer", nil, true)
	admin.do("PUT", "/api/me/device-idle", map[string]any{"days": 7}, true)
	e.at(5)
	admin.do("GET", "/api/me", nil, false)
	e.at(8)
	if _, me := admin.do("GET", "/api/me", nil, false); me["indexer"] != "" {
		t.Fatalf("unused indexer still indexes: %v", me["indexer"])
	}
}

func TestDemoCannotChangeDeviceIdle(t *testing.T) {
	_, _, demo, _, _ := demoEnv(t)
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{"PUT", "/api/me/device-idle", map[string]any{"days": 7}},
		{"POST", "/api/me/sessions/end-unused", nil},
		{"POST", "/api/me/sessions/current/last-upload", map[string]any{"at": time.Now().Unix()}},
	} {
		if code, out := demo.do(c.method, c.path, c.body, true); code != 403 || out["error"] != demoRefused {
			t.Fatalf("%s %s: %d %v", c.method, c.path, code, out)
		}
	}
}

func lastUploadOf(e *env, pub any) int64 {
	var v int64
	e.app.db.QueryRow(`SELECT last_upload_at FROM sessions WHERE pub=?`, pub).Scan(&v)
	return v
}

func TestBackfillLastUpload(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	phone := e.login("admin@x.org", ab)
	tablet := e.login("admin@x.org", ab)
	old := e.login("admin@x.org", ab)
	_, am := admin.do("GET", "/api/me", nil, false)
	_, pm := phone.do("GET", "/api/me", nil, false)
	_, tm := tablet.do("GET", "/api/me", nil, false)
	_, om := old.do("GET", "/api/me", nil, false)
	now := time.Now().Unix()
	path := "/api/me/sessions/current/last-upload"
	if code, _ := e.client().do("POST", path, map[string]any{"at": now}, true); code != 401 {
		t.Fatalf("signed out: %d", code)
	}
	if code, _ := phone.do("POST", path, map[string]any{"at": now - 3600}, false); code != 403 {
		t.Fatalf("without csrf: %d", code)
	}
	for _, b := range []any{map[string]any{"at": 0}, map[string]any{"at": -5}, map[string]any{}, map[string]any{"at": "x"}, map[string]any{"at": 1, "session": am["session_id"]}} {
		if code, _ := phone.do("POST", path, b, true); code != 400 {
			t.Fatalf("%v: %d", b, code)
		}
	}
	code, out := phone.do("POST", path, map[string]any{"at": now - 3600}, true)
	if code != 200 || out["set"] != true || lastUploadOf(e, pm["session_id"]) != now-3600 {
		t.Fatalf("set: %d %v", code, out)
	}
	// only this session
	if lastUploadOf(e, am["session_id"]) != 0 || lastUploadOf(e, tm["session_id"]) != 0 {
		t.Fatal("another session changed")
	}
	// only once
	if _, out := phone.do("POST", path, map[string]any{"at": now - 60}, true); out["set"] != false || lastUploadOf(e, pm["session_id"]) != now-3600 {
		t.Fatalf("set twice: %v", out)
	}
	// clamped: never in the future, never more than a year back
	tablet.do("POST", path, map[string]any{"at": now + 86400*30}, true)
	if v := lastUploadOf(e, tm["session_id"]); v < now || v > now+60 {
		t.Fatalf("future: %d", v)
	}
	old.do("POST", path, map[string]any{"at": 1000}, true)
	if v := lastUploadOf(e, om["session_id"]); v < now-365*86400 || v > now-365*86400+60 {
		t.Fatalf("too old: %d", v)
	}
	// a time the server recorded itself is never replaced
	e.readyItem(admin)
	got := lastUploadOf(e, am["session_id"])
	if got == 0 {
		t.Fatal("upload not recorded")
	}
	if _, out := admin.do("POST", path, map[string]any{"at": now - 7200}, true); out["set"] != false || lastUploadOf(e, am["session_id"]) != got {
		t.Fatalf("recorded upload replaced: %v", out)
	}
	// the storage overview shows it
	_, st := phone.do("GET", "/api/me/storage", nil, false)
	for _, d := range st["devices"].([]any) {
		dm := d.(map[string]any)
		if dm["id"] == pm["session_id"] && dm["last_upload_at"].(float64) != float64(now-3600) {
			t.Fatalf("overview: %v", dm)
		}
	}
}
