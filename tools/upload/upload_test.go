package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeServer implements the parts of the Cipherfilm API the uploader uses, with the same size checks, and can be
// told to fail in the ways a real line does.
type fakeServer struct {
	t      *testing.T
	mu     sync.Mutex
	email  string
	kdf    kdfParams
	auth   string
	wmpw   string
	csrf   string
	cookie string
	items  map[string]*fakeItem
	nextID int

	segPuts    int
	fail503    int // the next n segment PUTs answer 503
	failAfter  int // after this many segment PUTs, every further one answers 400 (0: never)
	expireOnce bool
	badID      string // POST /api/items answers with this id instead of a proper one
}

type fakeItem struct {
	kind, state   string
	size, count   int64
	segs          map[int64][]byte
	thumb, prev   []byte
	wrapped, meta string
}

func newFake(t *testing.T, email, password string) (*fakeServer, []byte) {
	f := &fakeServer{t: t, email: normEmail(email), items: map[string]*fakeItem{}, csrf: "csrf1", cookie: "s1"}
	f.kdf = kdfParams{Alg: "argon2id13", V: 1, Ops: minOps, Mem: minMem, Salt: b64.EncodeToString(randBytes(16))}
	authKey, kek, err := deriveFromPassword(password, f.kdf)
	if err != nil {
		t.Fatal(err)
	}
	master := randBytes(32)
	f.auth = b64.EncodeToString(authKey)
	f.wmpw = b64.EncodeToString(seal(master, kek, "wrap/master/pw", f.email))
	return f, master
}

func (f *fakeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	reply := func(code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(v)
	}
	fail := func(code int, msg string) { reply(code, map[string]string{"error": msg}) }
	p := r.URL.Path
	switch {
	case p == "/api/auth/params":
		reply(200, f.kdf)
		return
	case p == "/api/auth/login":
		var req struct{ Email, Auth string }
		json.NewDecoder(r.Body).Decode(&req)
		if req.Email != f.email || req.Auth != f.auth {
			fail(401, "wrong e-mail or password")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "__Host-sid", Value: f.cookie, Path: "/", Secure: true, HttpOnly: true})
		reply(200, map[string]any{"user": map[string]string{"id": "u1", "email": f.email}, "csrf": f.csrf, "wrapped_master_pw": f.wmpw})
		return
	}
	if c, err := r.Cookie("__Host-sid"); err != nil || c.Value != f.cookie {
		fail(401, "not signed in")
		return
	}
	if r.Method != "GET" && r.Header.Get("X-CSRF-Token") != f.csrf {
		fail(403, "bad csrf token")
		return
	}
	parts := strings.Split(strings.Trim(p, "/"), "/")
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.Method == "GET" && p == "/api/items":
		out := []map[string]any{}
		for id, it := range f.items {
			if it.state == "ready" {
				out = append(out, map[string]any{"id": id, "wrapped_item_key": it.wrapped, "meta_enc": it.meta})
			}
		}
		reply(200, map[string]any{"items": out, "next": "", "quota_left": 1 << 40, "unlimited": false})
	case r.Method == "POST" && p == "/api/items":
		var req struct {
			Kind         string `json:"kind"`
			Size         int64  `json:"size"`
			SegmentCount int64  `json:"segment_count"`
		}
		json.Unmarshal(body, &req)
		if req.SegmentCount != segmentCount(req.Size) || (req.Kind != "image" && req.Kind != "video") {
			fail(400, "invalid request")
			return
		}
		f.nextID++
		id := fmt.Sprintf("%032x", f.nextID)
		if f.badID != "" {
			id = f.badID
		}
		f.items[id] = &fakeItem{kind: req.Kind, state: "uploading", size: req.Size, count: req.SegmentCount, segs: map[int64][]byte{}}
		reply(201, map[string]string{"id": id})
	case len(parts) >= 4 && parts[1] == "items":
		it := f.items[parts[2]]
		if it == nil {
			fail(404, "not found")
			return
		}
		switch {
		case r.Method == "GET" && parts[3] == "upload":
			rec := []int64{}
			for n := range it.segs {
				rec = append(rec, n)
			}
			reply(200, map[string]any{"state": it.state, "size": it.size, "segment_count": it.count, "received": rec, "has_thumb": it.thumb != nil, "has_preview": it.prev != nil})
		case r.Method == "PUT" && parts[3] == "segments":
			n, _ := strconv.ParseInt(parts[4], 10, 64)
			f.segPuts++
			if f.fail503 > 0 {
				f.fail503--
				fail(503, "busy")
				return
			}
			if f.expireOnce {
				f.expireOnce = false
				f.cookie, f.csrf = "s2", "csrf2" // the session ended: the client must sign in again
				fail(401, "not signed in")
				return
			}
			if f.failAfter > 0 && f.segPuts > f.failAfter {
				fail(400, "upload failed")
				return
			}
			l := segPlain
			if n == it.count-1 {
				l = int(it.size - n*segPlain)
			}
			if n >= it.count || int64(len(body)) != cipherLen(int64(l)) {
				fail(400, "segment has the wrong size")
				return
			}
			it.segs[n] = body
			reply(200, map[string]bool{"ok": true})
		case r.Method == "PUT" && parts[3] == "thumb":
			it.thumb = body
			reply(200, map[string]bool{"ok": true})
		case r.Method == "PUT" && parts[3] == "preview":
			it.prev = body
			reply(200, map[string]bool{"ok": true})
		case r.Method == "POST" && parts[3] == "finalize":
			if int64(len(it.segs)) != it.count {
				fail(409, "not all parts have been uploaded yet")
				return
			}
			var req struct {
				W string `json:"wrapped_item_key"`
				M string `json:"meta_enc"`
			}
			json.Unmarshal(body, &req)
			it.wrapped, it.meta, it.state = req.W, req.M, "ready"
			reply(200, map[string]bool{"ok": true})
		default:
			fail(404, "not found")
		}
	default:
		fail(404, "not found")
	}
}

// decryptAll checks every finished item like cipherfilm-decrypt would and returns name → sha256 of the content.
func (f *fakeServer) decryptAll(t *testing.T, master []byte) map[string][32]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string][32]byte{}
	for id, it := range f.items {
		if it.state != "ready" {
			continue
		}
		ik, err := unwrapItemKey(mustB64(t, it.wrapped), master, id)
		if err != nil {
			t.Fatalf("%s: item key: %v", id, err)
		}
		raw, err := decryptMeta(mustB64(t, it.meta), ik, id)
		if err != nil {
			t.Fatalf("%s: meta: %v", id, err)
		}
		var m itemMeta
		json.Unmarshal(raw, &m)
		var all []byte
		for n := int64(0); n < it.count; n++ {
			pt, err := decryptSegment(ik, id, n, it.count, it.size, it.segs[n])
			if err != nil {
				t.Fatalf("%s seg %d: %v", m.Name, n, err)
			}
			all = append(all, pt...)
		}
		if int64(len(all)) != m.Size || m.Size != it.size {
			t.Fatalf("%s: size %d, meta says %d", m.Name, len(all), m.Size)
		}
		if _, dup := out[m.Name]; dup {
			t.Fatalf("%s uploaded twice", m.Name)
		}
		out[m.Name] = sha256.Sum256(all)
		// the original's SHA-256 is in the metadata, also for a file whose upload resumed (docs/CRYPTO.md)
		if sum := out[m.Name]; m.SHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("%s: meta sha256 %q, want %x", m.Name, m.SHA256, sum)
		}
	}
	return out
}

func TestUploadRetriesResumesAndSkipsDuplicates(t *testing.T) {
	const email, password = "Tester@Example.org", "pw ü 123"
	fake, master := newFake(t, email, password)
	srv := httptest.NewTLSServer(fake)
	defer srv.Close()

	dir := t.TempDir()
	want := map[string][32]byte{}
	for name, size := range map[string]int{"a.jpg": 1000, "sub/b.mov": 3*segPlain + 77, "c.png": segPlain, "empty.heic": 0} {
		data := randBytes(size)
		p := filepath.Join(dir, name)
		os.MkdirAll(filepath.Dir(p), 0o700)
		os.WriteFile(p, data, 0o600)
		want[filepath.Base(name)] = sha256.Sum256(data)
	}
	t.Setenv("CIPHERFILM_UPLOAD_STATE", t.TempDir())

	runOnce := func() (int, error) {
		t.Setenv("CIPHERFILM_PASSWORD", password) // each run takes it out of the environment
		o := options{server: srv.URL, email: email, parallel: 2, segments: 2}
		// newClient is replaced by one that trusts the test server's certificate
		testClient = func(c *client) {
			tr := srv.Client().Transport.(*http.Transport).Clone()
			c.http.Transport = tr
			c.backoff = func(int) time.Duration { return time.Millisecond }
		}
		var log bytes.Buffer
		code, err := run(context.Background(), o, dir, &log)
		t.Log(log.String())
		return code, err
	}

	// first run: two 503s (retried), a session that ends mid-way (signed in again), then the line "breaks" for good
	fake.fail503, fake.expireOnce, fake.failAfter = 2, true, 5
	if code, _ := runOnce(); code == 0 {
		t.Fatal("first run reported success although uploads failed")
	}
	if fake.csrf != "csrf2" {
		t.Fatal("did not sign in again after the session ended")
	}
	fake.mu.Lock()
	received := 0
	for _, it := range fake.items {
		received += len(it.segs)
	}
	fake.failAfter, fake.segPuts = 0, 0
	fake.mu.Unlock()
	if received == 0 {
		t.Fatal("nothing arrived in the first run")
	}

	// second run: continues; parts that arrived are not sent again
	if code, err := runOnce(); code != 0 || err != nil {
		t.Fatalf("second run: %d %v", code, err)
	}
	total := 0
	for _, size := range []int{1000, 3*segPlain + 77, segPlain, 0} {
		total += int(segmentCount(int64(size)))
	}
	if got := fake.segPuts; got != total-received {
		t.Fatalf("second run sent %d parts, want %d (%d of %d had arrived)", got, total-received, received, total)
	}
	got := fake.decryptAll(t, master)
	if len(got) != len(want) {
		t.Fatalf("library has %d files, want %d", len(got), len(want))
	}
	for name, sum := range want {
		if got[name] != sum {
			t.Fatalf("%s: content differs after upload", name)
		}
	}

	// third run with a fresh resume file: everything is found in the library and skipped
	t.Setenv("CIPHERFILM_UPLOAD_STATE", t.TempDir())
	fake.segPuts = 0
	before := len(fake.items)
	if code, err := runOnce(); code != 0 || err != nil {
		t.Fatalf("third run: %d %v", code, err)
	}
	if fake.segPuts != 0 || len(fake.items) != before {
		t.Fatalf("duplicates were uploaded again (%d parts, %d → %d items)", fake.segPuts, before, len(fake.items))
	}
}

func TestWrongPasswordIsReported(t *testing.T) {
	fake, _ := newFake(t, "a@example.org", "right")
	srv := httptest.NewTLSServer(fake)
	defer srv.Close()
	c, _ := newClient(srv.URL, "a@example.org", "", 2)
	c.http.Transport = srv.Client().Transport
	if _, _, err := c.login(context.Background(), "wrong"); err == nil || !strings.Contains(err.Error(), "wrong e-mail or password") {
		t.Fatalf("got %v", err)
	}
	if _, err := newClient("http://example.org", "a@example.org", "", 2); err == nil {
		t.Fatal("plain http accepted")
	}
}

func TestMalformedItemIdFromTheServerIsRefused(t *testing.T) {
	const email, password = "a@example.org", "pw"
	fake, _ := newFake(t, email, password)
	srv := httptest.NewTLSServer(fake)
	defer srv.Close()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.jpg"), randBytes(1000), 0o600)
	t.Setenv("CIPHERFILM_UPLOAD_STATE", t.TempDir())
	testClient = func(c *client) {
		c.http.Transport = srv.Client().Transport.(*http.Transport).Clone()
		c.backoff = func(int) time.Duration { return time.Millisecond }
	}
	for _, id := range []string{"./../../../../././escaped-file-b", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef"} {
		fake.badID = id
		t.Setenv("CIPHERFILM_PASSWORD", password) // each run takes it out of the environment
		var log bytes.Buffer
		if code, _ := run(context.Background(), options{server: srv.URL, email: email, parallel: 1, segments: 1}, dir, &log); code == 0 {
			t.Fatalf("%q: run reported success", id)
		}
		if it := fake.items[id]; it == nil || it.wrapped != "" || len(it.segs) != 0 || it.thumb != nil {
			t.Fatalf("%q: data was sent for the item", id)
		}
		delete(fake.items, id)
	}
}
