package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func staticFixture() *staticFiles {
	big := strings.Repeat("function f(){return 1}\n", 500)
	return newStatic(fstest.MapFS{
		"index.html":             {Data: []byte("<!doctype html><title>x</title>" + strings.Repeat(" ", 200))},
		"sw.js":                  {Data: []byte(big)},
		"assets/app-abc123.js":   {Data: []byte(big)},
		"assets/logo-abc123.png": {Data: []byte("\x89PNG not really")},
		"heic/worker.js":         {Data: []byte(big)},
	})
}

func get(h http.Handler, path string, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", path, nil)
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestStaticCompressionAndCaching(t *testing.T) {
	h := staticFixture()
	w := get(h, "/assets/app-abc123.js", map[string]string{"Accept-Encoding": "gzip, br"})
	if w.Header().Get("Content-Encoding") != "gzip" || w.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("not gzipped: %v", w.Header())
	}
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(zr)
	if !strings.HasPrefix(string(body), "function f()") {
		t.Fatal("gzip body differs")
	}
	if w.Body.Len() >= 11500 {
		t.Fatal("gzip did not shrink the asset")
	}
	if !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("hashed asset not cached: %s", w.Header().Get("Cache-Control"))
	}
	// no gzip when the client does not ask for it
	w = get(h, "/assets/app-abc123.js", nil)
	if w.Header().Get("Content-Encoding") != "" || w.Body.Len() != 500*len("function f(){return 1}\n") {
		t.Fatal("identity response wrong")
	}
	// entry points are always revalidated
	for _, p := range []string{"/", "/sw.js", "/heic/worker.js", "/index.html"} {
		if cc := get(h, p, nil).Header().Get("Cache-Control"); cc != "no-cache" {
			t.Fatalf("%s: Cache-Control %q", p, cc)
		}
	}
	// binary assets are not compressed
	if get(h, "/assets/logo-abc123.png", map[string]string{"Accept-Encoding": "gzip"}).Header().Get("Content-Encoding") != "" {
		t.Fatal("png was compressed")
	}
}

func TestStaticETagAndRoutes(t *testing.T) {
	h := staticFixture()
	w := get(h, "/assets/app-abc123.js", nil)
	etag := w.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no etag")
	}
	if w2 := get(h, "/assets/app-abc123.js", map[string]string{"If-None-Match": etag}); w2.Code != 304 {
		t.Fatalf("revalidation: %d", w2.Code)
	}
	// client routes get the app, missing files are real 404s, odd paths stay inside the bundle
	if w := get(h, "/invite/some-token", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "<!doctype html>") {
		t.Fatalf("spa route: %d", w.Code)
	}
	for _, p := range []string{"/assets/missing.js", "/nope.png", "/%2e%2e/secret.txt", "/heic/anything"} {
		if c := get(h, p, nil).Code; c != 404 {
			t.Fatalf("%s: %d", p, c)
		}
	}
	// path tricks never reach the file system: they are cleaned and fall back to the app (no extension) or 404
	if w := get(h, "/assets/../../etc/passwd", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "<!doctype html>") {
		t.Fatalf("traversal path: %d", w.Code)
	}
	r := httptest.NewRequest("POST", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != 405 {
		t.Fatalf("POST: %d", rec.Code)
	}
}
