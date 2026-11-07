package main

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Favorites, the search index and the people list. The phone computes the index itself (what is in a photo, where the
// faces are); the server only keeps it, encrypted with the item's key, so another device of the same person does not
// have to compute it again. Names of people are encrypted with the master key. Favorites are a plain flag, like album
// membership: the server sees which photos are marked, never what they show.

const (
	maxIndexBytes = 48 << 10 // one item's encrypted index: an image vector and the faces in it
	maxBlobBytes  = 2 << 20  // one encrypted per-account document (people and their names)
	indexPage     = 500
)

var modelNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// The per-account documents and index model families the apps use. Anything else is refused, so an account cannot
// pile up rows under names of its own; both stores also count toward the storage limit (usedBytesSQL).
var (
	blobNames     = map[string]bool{"people": true}
	indexFamilies = map[string]bool{"": true, "mcs2": true, "laionb32": true}
)

func (a *App) indexRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/items/favorite", a.auth(false, a.setFavorite))
	m.HandleFunc("PUT /api/items/{id}/index", a.auth(false, a.putIndex))
	m.HandleFunc("GET /api/index", a.auth(false, a.listing(a.listIndex)))
	m.HandleFunc("DELETE /api/index", a.auth(false, a.clearIndex))
	m.HandleFunc("GET /api/me/blobs/{name}", a.auth(false, a.getUserBlob))
	m.HandleFunc("PUT /api/me/blobs/{name}", a.auth(false, a.putUserBlob))
	m.HandleFunc("DELETE /api/me/blobs/{name}", a.auth(false, a.deleteUserBlob))
	// the open models the apps run for search: a redirect to Hugging Face, for apps that still ask here
	m.HandleFunc("GET /api/models/{name}", a.auth(false, a.getModel))
}

func blobOK(s string, max int) bool {
	b, err := b64.DecodeString(s)
	return err == nil && len(b) >= 1+24+16 && len(b) <= max
}

func (a *App) setFavorite(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req struct {
		ItemIDs  []string `json:"item_ids"`
		Favorite bool     `json:"favorite"`
	}
	if !readJSON(w, r, &req) || !validIDs(req.ItemIDs) {
		fail(w, 400, "invalid request")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	v := 0
	if req.Favorite {
		v = 1
	}
	for _, id := range req.ItemIDs {
		res, err := tx.Exec(`UPDATE items SET favorite=? WHERE id=? AND user_id=? AND state='ready'`, v, id, u.ID)
		if rowsAffected(res, err) != 1 {
			fail(w, 404, "not found")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		fail(w, 500, "server error")
		return
	}
	a.changed(u.ID, tItems)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) putIndex(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	it, ok := a.owned(w, r, u)
	if !ok {
		return
	}
	var req struct {
		DataEnc string `json:"data_enc"`
		// the entry's model tag, sent by apps that know explicit search (the entry itself is sealed)
		Model string `json:"model"`
	}
	bodyDeadline(w, jsonReadTime)
	r.Body = http.MaxBytesReader(w, r.Body, maxIndexBytes*2)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&req) != nil || !blobOK(req.DataEnc, maxIndexBytes) || len(req.Model) > 64 {
		fail(w, 400, "invalid request")
		return
	}
	// Where explicit search is allowed, two models may be in use: an app from before it would take the other model's
	// entries for outdated and overwrite them, back and forth. Only apps that say which model they used may write.
	if u.NSFW && req.Model == "" {
		fail(w, 409, "update the app to keep searching your photos")
		return
	}
	// one device indexes, the others read (sessions.go); the first that indexes becomes that device
	if !a.mayIndex(u, s) {
		writeJSON(w, 409, map[string]string{"error": "another device indexes your photos", "code": "not_indexer"})
		return
	}
	fam := modelFamily(req.Model)
	if !indexFamilies[fam] {
		fail(w, 400, "invalid request")
		return
	}
	// the entry costs storage like a file; replacing one costs only the difference
	var prev int64
	a.db.QueryRow(`SELECT COALESCE(SUM(LENGTH(data_enc)),0) FROM item_index WHERE item_id=? AND model IN (?,'')`, it.ID, fam).Scan(&prev)
	release, ok := a.reserveBytes(u.ID, int64(len(req.DataEnc))-prev)
	if !ok {
		fail(w, 413, "this would go over your storage limit")
		return
	}
	defer release()
	tx, err := a.db.Begin()
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO item_index(item_id,user_id,model,data_enc,updated_at) VALUES(?,?,?,?,?)
		ON CONFLICT(item_id,model) DO UPDATE SET data_enc=excluded.data_enc, updated_at=excluded.updated_at`, it.ID, u.ID, fam, req.DataEnc, a.now().UnixMilli()); err != nil {
		fail(w, 500, "server error")
		return
	}
	if fam != "" { // an entry from before 1.9.0 for this item is replaced by this one
		if _, err = tx.Exec(`DELETE FROM item_index WHERE item_id=? AND model=''`, it.ID); err != nil {
			fail(w, 500, "server error")
			return
		}
	}
	if tx.Commit() != nil {
		fail(w, 500, "server error")
		return
	}
	a.changed(u.ID, tIndex)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// modelFamily is the image model of an entry's tag ("laionb32+yunet23+sface21/1" -> "laionb32"): entries of one
// family compare with each other, whatever else the tag says.
func modelFamily(tag string) string {
	if i := strings.IndexAny(tag, "+/"); i >= 0 {
		tag = tag[:i]
	}
	if !modelNameRe.MatchString(tag) {
		return ""
	}
	return tag
}

// listIndex pages through the account's index entries by the time they were written, so a device that already has
// most of them asks only for what changed since (?since=ms).
func (a *App) listIndex(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	since := int64(0)
	after := ""
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			fail(w, 400, "invalid request")
			return
		}
		since = n
	}
	if v := r.URL.Query().Get("after"); v != "" {
		ts, id, ok := strings.Cut(v, ".")
		n, err := strconv.ParseInt(ts, 10, 64)
		if !ok || err != nil || !idRe.MatchString(id) {
			fail(w, 400, "invalid request")
			return
		}
		since, after = n, id
	}
	// ?model=family: only that model's entries (and those from before 1.9.0, of either); without it all of them
	fam, all := r.URL.Query().Get("model"), 1
	if fam != "" {
		if modelFamily(fam) != fam {
			fail(w, 400, "invalid request")
			return
		}
		all = 0
	}
	var rows *sql.Rows
	var err error
	if after != "" {
		rows, err = a.db.Query(`SELECT item_id,data_enc,updated_at FROM item_index WHERE user_id=? AND (?=1 OR model IN (?,''))
			AND (updated_at > ? OR (updated_at = ? AND item_id > ?)) ORDER BY updated_at, item_id LIMIT ?`, u.ID, all, fam, since, since, after, indexPage)
	} else {
		rows, err = a.db.Query(`SELECT item_id,data_enc,updated_at FROM item_index WHERE user_id=? AND (?=1 OR model IN (?,'')) AND updated_at >= ?
			ORDER BY updated_at, item_id LIMIT ?`, u.ID, all, fam, since, indexPage)
	}
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	next := ""
	sent := 0 // bytes of encrypted fields on this page
	for sent < pageBytes && rows.Next() {
		var id, data string
		var at int64
		if rows.Scan(&id, &data, &at) == nil {
			out = append(out, map[string]any{"item_id": id, "data_enc": data, "updated_at": at})
			next = fmt.Sprintf("%d.%s", at, id)
			sent += len(data)
		}
	}
	if len(out) < indexPage && sent < pageBytes {
		next = ""
	}
	writeJSON(w, 200, map[string]any{"entries": out, "next": next, "now": a.now().UnixMilli()})
}

// clearIndex removes the whole index and the people list, when search is turned off with "also delete"; with
// ?model=family only that model's entries (the other model's, after the person switched).
func (a *App) clearIndex(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if fam := r.URL.Query().Get("model"); fam != "" {
		if modelFamily(fam) != fam {
			fail(w, 400, "invalid request")
			return
		}
		a.db.Exec(`DELETE FROM item_index WHERE user_id=? AND model=?`, u.ID, fam)
		a.changed(u.ID, tIndex)
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	a.db.Exec(`DELETE FROM item_index WHERE user_id=?`, u.ID)
	a.db.Exec(`DELETE FROM user_blobs WHERE user_id=? AND name='people'`, u.ID)
	a.changed(u.ID, tIndex|tPeople)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) getUserBlob(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	name := r.PathValue("name")
	if !blobNames[name] {
		fail(w, 404, "not found")
		return
	}
	var data string
	var version int64
	if a.db.QueryRow(`SELECT data_enc,version FROM user_blobs WHERE user_id=? AND name=?`, u.ID, name).Scan(&data, &version) != nil {
		fail(w, 404, "not found")
		return
	}
	writeJSON(w, 200, map[string]any{"data_enc": data, "version": version})
}

// putUserBlob replaces a document only if the caller saw the current version (0: it must not exist yet), so two
// devices editing at once don't silently undo each other: the second gets 409 and merges.
func (a *App) putUserBlob(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	name := r.PathValue("name")
	if !blobNames[name] {
		fail(w, 404, "not found")
		return
	}
	var req struct {
		DataEnc string `json:"data_enc"`
		Version int64  `json:"version"`
	}
	bodyDeadline(w, 2*jsonReadTime)
	r.Body = http.MaxBytesReader(w, r.Body, maxBlobBytes*2)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&req) != nil || !blobOK(req.DataEnc, maxBlobBytes) || req.Version < 0 {
		fail(w, 400, "invalid request")
		return
	}
	var prev int64
	a.db.QueryRow(`SELECT COALESCE(SUM(LENGTH(data_enc)),0) FROM user_blobs WHERE user_id=? AND name=?`, u.ID, name).Scan(&prev)
	release, ok := a.reserveBytes(u.ID, int64(len(req.DataEnc))-prev)
	if !ok {
		fail(w, 413, "this would go over your storage limit")
		return
	}
	defer release()
	var res sql.Result
	var err error
	if req.Version == 0 {
		res, err = a.db.Exec(`INSERT INTO user_blobs(user_id,name,data_enc,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT DO NOTHING`, u.ID, name, req.DataEnc, a.now().UnixMilli())
	} else {
		res, err = a.db.Exec(`UPDATE user_blobs SET data_enc=?, version=version+1, updated_at=? WHERE user_id=? AND name=? AND version=?`, req.DataEnc, a.now().UnixMilli(), u.ID, name, req.Version)
	}
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if rowsAffected(res, nil) != 1 {
		fail(w, 409, "changed on another device")
		return
	}
	a.changed(u.ID, tPeople)
	writeJSON(w, 200, map[string]any{"version": req.Version + 1})
}

func (a *App) deleteUserBlob(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	name := r.PathValue("name")
	if !blobNames[name] {
		fail(w, 404, "not found")
		return
	}
	a.db.Exec(`DELETE FROM user_blobs WHERE user_id=? AND name=?`, u.ID, name)
	a.changed(u.ID, tPeople)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// The search models: one list (models.json) for the server and every app, each file pinned to a Hugging Face commit
// and a SHA-256 (docs/MODELS.md). The apps download them from Hugging Face themselves and check the hash.
//
//go:embed models.json
var modelsJSON []byte

var modelURLs = func() map[string]string {
	var list []struct{ Name, URL string }
	if err := json.Unmarshal(modelsJSON, &list); err != nil {
		panic("models.json: " + err.Error())
	}
	m := map[string]string{}
	for _, x := range list {
		if !modelNameRe.MatchString(x.Name) || !strings.HasPrefix(x.URL, "https://huggingface.co/") {
			panic("models.json: " + x.Name)
		}
		m[x.Name] = x.URL
	}
	return m
}()

// getModel sends apps that still ask the server (2.1.x) to the file's pinned Hugging Face URL. Same rules as when
// the server had the files: signed-in people only, the explicit model only for people allowed it, so the answer
// doesn't tell anyone else it exists. The app checks the SHA-256 built into it, wherever the bytes came from.
func (a *App) getModel(w http.ResponseWriter, r *http.Request, u *user, _ *session) {
	name := r.PathValue("name")
	url, ok := modelURLs[name]
	// the explicit-search model goes only to people the admin allowed it (off by default)
	if !ok || (strings.HasPrefix(name, "nsfw-") && !u.NSFW) {
		fail(w, 404, "not found")
		return
	}
	// Apps since 2.1.4 download from Hugging Face themselves. Older ones ask here and follow no redirect (their
	// download kept the session cookie to this server), so the file is passed through from its pinned URL; they
	// check its SHA-256 as before. A Range header goes along, so their resume still works.
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
	}
	resp, err := modelClient.Do(req)
	if err != nil {
		fail(w, 502, "couldn't reach the model's host")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		fail(w, 502, "the model's host answered "+resp.Status)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "private, no-store") // per person: the explicit model's permission can change
	for _, k := range []string{"Content-Length", "Content-Range", "Accept-Ranges"} {
		if v := resp.Header.Get(k); v != "" {
			h.Set(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(idleWriter{w, http.NewResponseController(w)}, resp.Body)
}

// modelClient fetches a pinned model for an older app: Hugging Face's redirect to its CDN is followed (https only),
// and a host that doesn't start answering within half a minute is given up on.
var modelClient = &http.Client{
	Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 30 * time.Second, TLSHandshakeTimeout: 15 * time.Second},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 6 || req.URL.Scheme != "https" {
			return errors.New("a model is only fetched over https, in a few hops")
		}
		return nil
	},
}

// idleWriter moves the write deadline forward before every write, so a long download is cut off only when it stalls.
type idleWriter struct {
	http.ResponseWriter
	rc *http.ResponseController
}

func (iw idleWriter) Write(p []byte) (int, error) {
	iw.rc.SetWriteDeadline(time.Now().Add(2 * time.Minute))
	return iw.ResponseWriter.Write(p)
}
