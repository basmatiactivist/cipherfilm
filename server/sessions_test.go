package main

import (
	"database/sql"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func (e *env) login(email string, b map[string]any) *client {
	e.t.Helper()
	c := e.client()
	if code, out := c.do("POST", "/api/auth/login", map[string]string{"email": email, "auth": b["auth"].(string)}, false); code != 200 {
		e.t.Fatalf("login: %d %v", code, out)
	}
	return c
}

func sessionList(t *testing.T, c *client) []map[string]any {
	t.Helper()
	code, out := c.do("GET", "/api/me/sessions", nil, false)
	if code != 200 {
		t.Fatalf("sessions: %d", code)
	}
	var l []map[string]any
	for _, x := range out["sessions"].([]any) {
		l = append(l, x.(map[string]any))
	}
	return l
}

func TestDevicesCanBeListedAndSignedOut(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	phone := e.login("admin@x.org", ab)
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	l := sessionList(t, admin)
	if len(l) != 2 {
		t.Fatalf("two devices expected, got %v", l)
	}
	var other string
	for _, s := range l {
		if s["current"] != true {
			other = s["id"].(string)
		}
	}
	if code, _ := bob.do("DELETE", "/api/me/sessions/"+other, nil, true); code != 404 {
		t.Fatalf("someone else's device: %d", code)
	}
	if code, _ := admin.do("DELETE", "/api/me/sessions/"+other, nil, false); code != 403 {
		t.Fatalf("without csrf: %d", code)
	}
	if code, _ := admin.do("DELETE", "/api/me/sessions/"+other, nil, true); code != 200 {
		t.Fatalf("sign out device: %d", code)
	}
	if code, _ := phone.do("GET", "/api/me", nil, false); code != 401 {
		t.Fatalf("signed-out device still in: %d", code)
	}
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/items", nil)
	if resp, err := phone.c.Do(req); err != nil || resp.Header.Get("X-CF-Session") != "revoked" {
		t.Fatalf("signed-out device not told: %v", err)
	}
	solo := e.login("admin@x.org", ab)
	solo.do("POST", "/api/auth/logout", nil, true)
	req, _ = http.NewRequest("GET", e.srv.URL+"/api/items", nil)
	if resp, _ := solo.c.Do(req); resp.Header.Get("X-CF-Session") != "" {
		t.Fatal("an ordinary sign-out marked as revoked")
	}
	_, me := admin.do("GET", "/api/me", nil, false)
	if code, _ := admin.do("DELETE", "/api/me/sessions/"+me["session_id"].(string), nil, true); code != 400 {
		t.Fatalf("own session: %d", code)
	}
	p2, p3 := e.login("admin@x.org", ab), e.login("admin@x.org", ab)
	if code, out := admin.do("POST", "/api/me/sessions/end-others", nil, true); code != 200 || out["ended"].(float64) != 2 {
		t.Fatalf("end others: %d %v", code, out)
	}
	for _, c := range []*client{p2, p3} {
		if code, _ := c.do("GET", "/api/me", nil, false); code != 401 {
			t.Fatalf("other device still in: %d", code)
		}
	}
	if code, _ := admin.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatalf("this device signed out too: %d", code)
	}
}

func TestOneDeviceIndexes(t *testing.T) {
	e := newEnv(t)
	admin, ab := e.setupAdmin("admin@x.org")
	phone := e.login("admin@x.org", ab)
	i1 := e.readyItem(admin)
	put := func(c *client, model string) int {
		code, _ := c.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": rb(200), "model": model}, true)
		return code
	}
	if put(phone, "mcs2/2") != 200 {
		t.Fatal("first device to index")
	}
	if code := put(admin, "mcs2/2"); code != 409 {
		t.Fatalf("second device indexed too: %d", code)
	}
	_, me := admin.do("GET", "/api/me", nil, false)
	_, pm := phone.do("GET", "/api/me", nil, false)
	if me["indexer"] != pm["session_id"] {
		t.Fatalf("indexer %v, phone %v", me["indexer"], pm["session_id"])
	}
	// the person moves indexing to this device
	if code, _ := admin.do("PUT", "/api/me/indexer", nil, true); code != 200 || put(admin, "mcs2/2") != 200 || put(phone, "mcs2/2") != 409 {
		t.Fatal("claiming the indexer")
	}
	// the indexer signs out: the next device takes over
	admin.do("POST", "/api/auth/logout", nil, true)
	if put(phone, "mcs2/2") != 200 {
		t.Fatal("after the indexer signed out")
	}
	if code, _ := phone.do("DELETE", "/api/me/indexer", nil, true); code != 200 {
		t.Fatal("drop indexer")
	}
	if _, pm := phone.do("GET", "/api/me", nil, false); pm["indexer"] != "" {
		t.Fatalf("indexer after drop: %v", pm["indexer"])
	}
}

func TestIndexEntriesArePerModel(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	i1 := e.readyItem(admin)
	a, b := rb(200), rb(200)
	admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": a, "model": "mcs2+yunet23+sface21/2"}, true)
	admin.do("PUT", "/api/items/"+i1+"/index", map[string]any{"data_enc": b, "model": "laionb32+yunet23+sface21/1"}, true)
	get := func(q string) []string {
		_, out := admin.do("GET", "/api/index?since=0"+q, nil, false)
		var l []string
		for _, x := range out["entries"].([]any) {
			l = append(l, x.(map[string]any)["data_enc"].(string))
		}
		return l
	}
	if l := get("&model=mcs2"); len(l) != 1 || l[0] != a {
		t.Fatalf("mcs2: %v", l)
	}
	if l := get("&model=laionb32"); len(l) != 1 || l[0] != b {
		t.Fatalf("laionb32: %v", l)
	}
	if l := get(""); len(l) != 2 {
		t.Fatalf("all: %v", l)
	}
	if code, _ := admin.do("GET", "/api/index?model=bad!", nil, false); code != 400 {
		t.Fatalf("bad model: %d", code)
	}
	admin.do("DELETE", "/api/index?model=laionb32", nil, true)
	if l := get(""); len(l) != 1 || l[0] != a {
		t.Fatalf("after deleting one model: %v", l)
	}
}

// A database from before 1.9.0 (one entry per item, sessions without a pub id) keeps its entries and sessions.
func TestMigrationKeepsIndexAndSessions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)`,
		`CREATE TABLE items (id TEXT PRIMARY KEY)`,
		`CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
		`CREATE TABLE item_index (item_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data_enc TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
		`INSERT INTO users VALUES ('u1','a@x.org')`, `INSERT INTO items VALUES ('i1')`,
		`INSERT INTO sessions VALUES ('h1','u1','c',1,1,9999999999), ('h2','u1','c',1,1,9999999999)`,
		`INSERT INTO item_index VALUES ('i1','u1','old',5)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	db.Close()
	// only the migration: the schema's other tables don't matter here
	db, _ = sql.Open("sqlite", "file:"+path)
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE invites (id TEXT)`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db); err != nil {
		t.Fatal(err)
	}
	var model, data string
	if err := db.QueryRow(`SELECT model,data_enc FROM item_index WHERE item_id='i1'`).Scan(&model, &data); err != nil || model != "" || data != "old" {
		t.Fatalf("entry: %q %q %v", model, data, err)
	}
	var n int
	db.QueryRow(`SELECT COUNT(DISTINCT pub) FROM sessions WHERE length(pub)=24`).Scan(&n)
	if n != 2 {
		t.Fatalf("pub ids: %d", n)
	}
	if err := migrate(db); err != nil { // runs again at every start
		t.Fatal(err)
	}
}

// People signing out their own devices, however often, must not push the admins' actions out of the activity log.
func TestOwnSignOutsDoNotFlushTheActivityLog(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.invite(admin, "carla@x.org")
	for i := 0; i < auditKeep+20; i++ {
		e.app.audit("bob@x.org", "signed out a device", "bob@x.org", "phone")
	}
	if _, out := bob.do("POST", "/api/me/sessions/end-others", nil, true); out["ended"] != float64(0) {
		t.Fatalf("end-others: %v", out)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action='signed out other devices'`).Scan(&n)
	if n != 0 {
		t.Fatal("logged signing out other devices when there were none")
	}
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE actor='admin@x.org'`).Scan(&n)
	if n != 2 {
		t.Fatalf("admin entries kept: %d", n)
	}
	_, out := admin.do("GET", "/api/admin/audit", nil, false)
	invites := 0
	for _, x := range out["entries"].([]any) {
		if x.(map[string]any)["action"] == "invited" {
			invites++
		}
	}
	if invites != 2 {
		t.Fatalf("admin entries shown: %d", invites)
	}
}

// The notices table of the development versions had a CHECK on kind; it is rebuilt without one, keeping the rows and
// the id counter (the apps remember dismissed ids: an id must not come again), once.
func TestNoticesTableLosesItsCheck(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	old := strings.Replace(schema, "  kind TEXT NOT NULL,\n", "  kind TEXT NOT NULL CHECK (kind IN ('sign_in','2fa_reset')),\n", 1)
	if old == schema {
		t.Fatal("the schema's notices table changed: update this test")
	}
	for _, q := range []string{
		old,
		`INSERT INTO users(id,email,role,kdf,auth_hash,pubkey,wrapped_master_pw,wrapped_master_recovery,wrapped_privkey,recovery_hash,created_at) VALUES ('u1','a@x.org','admin','','','','','','','',1)`,
		`INSERT INTO notices(user_id,kind,device,session_pub,at,dismissed) VALUES ('u1','sign_in','Phone','p1',5,0), ('u1','2fa_reset','','',6,1), ('u1','sign_in','x','',7,0)`,
		`DELETE FROM notices WHERE at=7`, // pruned: its id is not to come again
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO notices(user_id,kind,at) VALUES ('u1','password_used',8)`); err == nil {
		t.Fatal("the old table took a new kind")
	}
	db.Close()
	for i := 0; i < 2; i++ { // and again at the next start
		db, err := openDB(path)
		if err != nil {
			t.Fatal(err)
		}
		var def string
		db.QueryRow(`SELECT sql FROM sqlite_master WHERE name='notices'`).Scan(&def)
		if strings.Contains(def, "CHECK") {
			t.Fatalf("still: %s", def)
		}
		var n, idx int
		db.QueryRow(`SELECT COUNT(*) FROM notices WHERE (id=1 AND kind='sign_in' AND device='Phone' AND session_pub='p1' AND at=5 AND dismissed=0)
			OR (id=2 AND kind='2fa_reset' AND dismissed=1)`).Scan(&n)
		db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='notices_user'`).Scan(&idx)
		if n != 2 || idx != 1 {
			t.Fatalf("rows %d, index %d", n, idx)
		}
		if i == 0 {
			res, err := db.Exec(`INSERT INTO notices(user_id,kind,at) VALUES ('u1','password_used',8)`)
			if err != nil {
				t.Fatal(err)
			}
			if id, _ := res.LastInsertId(); id != 4 {
				t.Fatalf("new id %d: an old one again", id)
			}
		}
		db.Close()
	}
}
