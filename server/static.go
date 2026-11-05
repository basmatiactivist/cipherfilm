package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

// staticFiles serves the embedded web app. Text assets are gzip-compressed once at start-up (the bundle is
// mostly libsodium and compresses about 3x), hashed assets are cached for a year, and the entry points
// (index.html, sw.js, the HEIC worker) are always revalidated so an update takes effect on the next load.
type staticFiles struct {
	files map[string]*asset
}

type asset struct {
	raw, gz []byte
	ctype   string
	etag    string
	cache   string
}

func compressible(name string) bool {
	switch path.Ext(name) {
	case ".js", ".css", ".html", ".json", ".svg", ".txt", ".webmanifest":
		return true
	}
	return false
}

func cacheFor(name string) string {
	if strings.HasPrefix(name, "assets/") || strings.HasPrefix(name, "workers/") {
		return "public, max-age=31536000, immutable" // file names carry a content hash
	}
	return "no-cache"
}

func newStatic(fsys fs.FS) *staticFiles {
	s := &staticFiles{files: map[string]*asset{}}
	fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || path.Base(p) == ".gitkeep" {
			return nil
		}
		raw, err := fs.ReadFile(fsys, p)
		if err != nil {
			return nil
		}
		a := &asset{raw: raw, cache: cacheFor(p)}
		sum := sha256.Sum256(raw)
		a.etag = `"` + hex.EncodeToString(sum[:12]) + `"`
		a.ctype = mime.TypeByExtension(path.Ext(p))
		if a.ctype == "" {
			a.ctype = "application/octet-stream"
		}
		if compressible(p) {
			var b bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&b, gzip.BestCompression)
			zw.Write(raw)
			zw.Close()
			if b.Len() < len(raw) {
				a.gz = b.Bytes()
			}
		}
		s.files[p] = a
		return nil
	})
	return s
}

func (s *staticFiles) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	a := s.files[name]
	if a == nil {
		// Client-side routes (/invite/<token>, /recover) get the app; a missing file with an extension is a real 404.
		if path.Ext(name) != "" || strings.HasPrefix(name, "heic/") {
			http.NotFound(w, r) // /heic/ carries an eval-permitting policy: only the worker file lives there
			return
		}
		name = "index.html"
		a = s.files[name]
		if a == nil {
			http.NotFound(w, r)
			return
		}
	}
	h := w.Header()
	h.Set("Content-Type", a.ctype)
	h.Set("Cache-Control", a.cache)
	h.Set("ETag", a.etag)
	body := a.raw
	if a.gz != nil {
		h.Add("Vary", "Accept-Encoding")
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h.Set("Content-Encoding", "gzip")
			body = a.gz
		}
	}
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
}
