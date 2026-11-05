package main

import (
	"encoding/binary"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Many encrypted thumbnails in one response. A library grid needs dozens at once, and one request per thumbnail
// costs a round trip each (slow over the internet or a VPN). The server still only sees which items are asked for,
// as it does with single requests, and sends the same ciphertext.
//
//	POST /api/items/thumbs {"item_ids": [...]} (at most 100)
//	-> for each id, in the order asked: u32 big-endian length, then that many bytes; 0xFFFFFFFF when the item has no
//	   thumbnail or isn't the caller's.

const thumbBatch = 100

func (a *App) thumbRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/items/thumbs", a.auth(false, a.thumbs))
}

func (a *App) thumbs(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req idsReq
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.ItemIDs) == 0 || len(req.ItemIDs) > thumbBatch {
		fail(w, 400, "invalid request")
		return
	}
	for _, id := range req.ItemIDs {
		if !idRe.MatchString(id) {
			fail(w, 400, "invalid request")
			return
		}
	}
	// which of them are the caller's (one query; the ids are checked hex, passed as parameters)
	args := []any{u.ID}
	for _, id := range req.ItemIDs {
		args = append(args, id)
	}
	rows, err := a.db.Query(`SELECT id FROM items WHERE user_id=? AND has_thumb=1 AND id IN (?`+strings.Repeat(",?", len(req.ItemIDs)-1)+`)`, args...)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	mine := map[string]bool{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			mine[id] = true
		}
	}
	rows.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	var hdr [4]byte
	for _, id := range req.ItemIDs {
		var b []byte
		if mine[id] {
			b = readSmall(filepath.Join(a.itemDir(id), "thumb"), maxThumbBytes)
		}
		if b == nil {
			binary.BigEndian.PutUint32(hdr[:], 0xFFFFFFFF)
			w.Write(hdr[:])
			continue
		}
		binary.BigEndian.PutUint32(hdr[:], uint32(len(b)))
		w.Write(hdr[:])
		w.Write(b)
	}
}

// readSmall reads a file of at most max bytes, or returns nil.
func readSmall(path string, max int) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > int64(max) {
		return nil
	}
	b := make([]byte, fi.Size())
	if _, err := io.ReadFull(f, b); err != nil {
		return nil
	}
	return b
}
