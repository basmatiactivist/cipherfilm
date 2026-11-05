package main

import (
	"net/http"
)

const maxAlbumsPerUser = 1000
const maxAlbumBatch = 500

// maxAlbumEntries bounds all album memberships of one account together; they cost space but no quota.
const maxAlbumEntries = 200000

func (a *App) albumRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/albums", a.auth(false, a.listing(a.listAlbums)))
	m.HandleFunc("POST /api/albums", a.auth(false, a.createAlbum))
	m.HandleFunc("PATCH /api/albums/{id}", a.auth(false, a.renameAlbum))
	m.HandleFunc("DELETE /api/albums/{id}", a.auth(false, a.deleteAlbum))
	m.HandleFunc("PUT /api/albums/{id}/items", a.auth(false, a.addAlbumItems))
	m.HandleFunc("DELETE /api/albums/{id}/items/{item}", a.auth(false, a.removeAlbumItem))
}

// nameOK: encrypted album names are small AEAD blobs (version + nonce + tag + padded name).
func nameOK(s string) bool {
	b, err := b64.DecodeString(s)
	return err == nil && len(b) >= 1+24+16 && len(b) <= 1024
}

func (a *App) ownsAlbum(w http.ResponseWriter, r *http.Request, u *user) (string, bool) {
	id := r.PathValue("id")
	var n int
	if !idRe.MatchString(id) {
		fail(w, 404, "not found")
		return "", false
	}
	a.db.QueryRow(`SELECT COUNT(*) FROM albums WHERE id=? AND user_id=?`, id, u.ID).Scan(&n)
	if n != 1 {
		fail(w, 404, "not found")
		return "", false
	}
	return id, true
}

func (a *App) listAlbums(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	rows, err := a.db.Query(`SELECT id,name_enc,created_at FROM albums WHERE user_id=? ORDER BY created_at, id`, u.ID)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	type album struct {
		ID      string   `json:"id"`
		NameEnc string   `json:"name_enc"`
		Created int64    `json:"created_at"`
		ItemIDs []string `json:"item_ids"`
	}
	var list []*album
	byID := map[string]*album{}
	for rows.Next() {
		x := &album{ItemIDs: []string{}}
		if rows.Scan(&x.ID, &x.NameEnc, &x.Created) == nil {
			list = append(list, x)
			byID[x.ID] = x
		}
	}
	rows.Close()
	mem, err := a.db.Query(`SELECT ai.album_id, ai.item_id FROM album_items ai JOIN albums al ON al.id=ai.album_id JOIN items it ON it.id=ai.item_id
		WHERE al.user_id=? AND it.state='ready' AND it.trashed_at IS NULL ORDER BY ai.added_at, ai.item_id`, u.ID)
	if err == nil {
		defer mem.Close()
		for mem.Next() {
			var aid, iid string
			if mem.Scan(&aid, &iid) == nil && byID[aid] != nil {
				byID[aid].ItemIDs = append(byID[aid].ItemIDs, iid)
			}
		}
	}
	if list == nil {
		list = []*album{}
	}
	writeJSON(w, 200, map[string]any{"albums": list})
}

type albumReq struct {
	ID      string `json:"id"`
	NameEnc string `json:"name_enc"`
}

// The client picks the album id because the encrypted name is bound to it.
func (a *App) createAlbum(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req albumReq
	if !readJSON(w, r, &req) {
		return
	}
	if !idRe.MatchString(req.ID) || !nameOK(req.NameEnc) {
		fail(w, 400, "invalid request")
		return
	}
	// counted in the insert itself, so concurrent creates cannot pass the limit together
	res, err := a.db.Exec(`INSERT INTO albums(id,user_id,name_enc,created_at) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM albums WHERE user_id=?) < ?`,
		req.ID, u.ID, req.NameEnc, a.now().Unix(), u.ID, maxAlbumsPerUser)
	if err != nil {
		fail(w, 409, "could not create the album")
		return
	}
	if rowsAffected(res, err) != 1 {
		fail(w, 400, "too many albums")
		return
	}
	writeJSON(w, 201, map[string]bool{"ok": true})
}

func (a *App) renameAlbum(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	id, ok := a.ownsAlbum(w, r, u)
	if !ok {
		return
	}
	var req albumReq
	if !readJSON(w, r, &req) || !nameOK(req.NameEnc) || (req.ID != "" && req.ID != id) {
		fail(w, 400, "invalid request")
		return
	}
	a.db.Exec(`UPDATE albums SET name_enc=? WHERE id=? AND user_id=?`, req.NameEnc, id, u.ID)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// Deleting an album never deletes its items; membership rows cascade away.
func (a *App) deleteAlbum(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	id, ok := a.ownsAlbum(w, r, u)
	if !ok {
		return
	}
	a.db.Exec(`DELETE FROM albums WHERE id=? AND user_id=?`, id, u.ID)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

type itemsReq struct {
	ItemIDs []string `json:"item_ids"`
}

func (a *App) addAlbumItems(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	id, ok := a.ownsAlbum(w, r, u)
	if !ok {
		return
	}
	var req itemsReq
	if !readJSON(w, r, &req) || len(req.ItemIDs) == 0 || len(req.ItemIDs) > maxAlbumBatch {
		fail(w, 400, "invalid request")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	var have int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM album_items ai JOIN albums al ON al.id=ai.album_id WHERE al.user_id=?`, u.ID).Scan(&have); err != nil {
		fail(w, 500, "server error")
		return
	}
	if have+len(req.ItemIDs) > maxAlbumEntries {
		fail(w, 400, "too many album entries")
		return
	}
	for _, iid := range req.ItemIDs {
		var n int
		if !idRe.MatchString(iid) {
			fail(w, 400, "invalid request")
			return
		}
		// only the caller's own, finished items can be added
		tx.QueryRow(`SELECT COUNT(*) FROM items WHERE id=? AND user_id=? AND state='ready' AND trashed_at IS NULL`, iid, u.ID).Scan(&n)
		if n != 1 {
			fail(w, 404, "not found")
			return
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO album_items(album_id,item_id,added_at) VALUES (?,?,?)`, id, iid, a.now().Unix()); err != nil {
			fail(w, 500, "server error")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		fail(w, 500, "server error")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) removeAlbumItem(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	id, ok := a.ownsAlbum(w, r, u)
	if !ok {
		return
	}
	iid := r.PathValue("item")
	if !idRe.MatchString(iid) {
		fail(w, 404, "not found")
		return
	}
	a.db.Exec(`DELETE FROM album_items WHERE album_id=? AND item_id=?`, id, iid)
	writeJSON(w, 200, map[string]bool{"ok": true})
}
