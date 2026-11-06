package main

import (
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// The person's devices: every signed-in session, so one that was lost or isn't theirs can be signed out from another,
// and the one device that computes the search index (docs/SEARCH.md, "One device indexes"). The others only read
// the index; two devices indexing at once did the same work twice and, with two models in use, undid each other.

var pubRe = regexp.MustCompile(`^[0-9a-f]{24}$`)

func (a *App) sessionRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/me/sessions", a.auth(false, a.listSessions))
	m.HandleFunc("DELETE /api/me/sessions/{id}", a.auth(false, a.endSession))
	m.HandleFunc("POST /api/me/sessions/end-others", a.auth(false, a.endOtherSessions))
	m.HandleFunc("PUT /api/me/indexer", a.auth(false, a.claimIndexer))
	m.HandleFunc("DELETE /api/me/indexer", a.auth(false, a.dropIndexer))
}

// deviceName is what the session list shows: the app's own name for the device (X-CF-Device, e.g. "Pixel 8 · Android
// app"), else a guess from the browser's User-Agent. It is only a label the device chose, never used for a decision.
func deviceName(r *http.Request) string {
	if r == nil {
		return ""
	}
	if v := clean(r.Header.Get("X-CF-Device")); v != "" {
		return v
	}
	ua := r.UserAgent()
	browser := ""
	for _, b := range []struct{ key, name string }{{"Edg/", "Edge"}, {"Firefox/", "Firefox"}, {"Chrome/", "Chrome"}, {"Safari/", "Safari"}} {
		if strings.Contains(ua, b.key) {
			browser = b.name
			break
		}
	}
	os := ""
	for _, o := range []struct{ key, name string }{{"Android", "Android"}, {"iPhone", "iPhone"}, {"iPad", "iPad"}, {"Mac OS X", "macOS"}, {"Windows", "Windows"}, {"Linux", "Linux"}} {
		if strings.Contains(ua, o.key) {
			os = o.name
			break
		}
	}
	switch {
	case browser != "" && os != "":
		return browser + " on " + os
	case browser != "":
		return browser
	case strings.HasPrefix(ua, "okhttp/"):
		return "Android app"
	case strings.Contains(ua, "CFNetwork"):
		return "Mac app"
	}
	return ""
}

func clean(s string) string {
	s = strings.Map(func(c rune) rune {
		if unicode.IsPrint(c) {
			return c
		}
		return -1
	}, strings.TrimSpace(s))
	if r := []rune(s); len(r) > 80 {
		s = string(r[:80])
	}
	return s
}

// liveIndexer is the account's indexing device, or "" if none is chosen or its session has ended (signed out,
// expired, password changed): then the next device that indexes takes over.
func (a *App) liveIndexer(u *user) string {
	if u.Indexer == "" {
		return ""
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE pub=? AND user_id=? AND expires_at>=?`, u.Indexer, u.ID, a.now().Unix()).Scan(&n)
	if n == 0 {
		return ""
	}
	return u.Indexer
}

// mayIndex makes this session the indexer if there is none (or it is gone) and says whether it is the indexer now.
func (a *App) mayIndex(u *user, s *session) bool {
	if u.Indexer == s.Pub {
		return true
	}
	res, err := a.db.Exec(`UPDATE users SET indexer=? WHERE id=? AND (indexer='' OR indexer=? OR NOT EXISTS (SELECT 1 FROM sessions WHERE pub=users.indexer AND user_id=users.id AND expires_at>=?))`,
		s.Pub, u.ID, s.Pub, a.now().Unix())
	if rowsAffected(res, err) == 1 {
		u.Indexer = s.Pub
		return true
	}
	return false
}

func (a *App) listSessions(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	rows, err := a.db.Query(`SELECT pub,device,created_at,last_seen FROM sessions WHERE user_id=? AND expires_at>=? ORDER BY last_seen DESC`, u.ID, a.now().Unix())
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer rows.Close()
	indexer := a.liveIndexer(u)
	out := []map[string]any{}
	for rows.Next() {
		var pub, device string
		var created, seen int64
		if rows.Scan(&pub, &device, &created, &seen) == nil {
			out = append(out, map[string]any{"id": pub, "device": device, "created_at": created, "last_seen": seen,
				"current": pub == s.Pub, "indexer": pub == indexer})
		}
	}
	writeJSON(w, 200, map[string]any{"sessions": out})
}

// endSession signs another device out: its next request is refused and the app forgets the library (as at sign-out).
func (a *App) endSession(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	id := r.PathValue("id")
	if !pubRe.MatchString(id) {
		fail(w, 404, "not found")
		return
	}
	if id == s.Pub {
		fail(w, 400, "use Sign out for this device")
		return
	}
	var device string
	a.db.QueryRow(`SELECT device FROM sessions WHERE pub=? AND user_id=?`, id, u.ID).Scan(&device)
	a.remember(`pub=? AND user_id=?`, id, u.ID)
	res, err := a.db.Exec(`DELETE FROM sessions WHERE pub=? AND user_id=?`, id, u.ID)
	if rowsAffected(res, err) != 1 {
		fail(w, 404, "not found")
		return
	}
	a.audit(u.Email, "signed out a device", u.Email, device)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) endOtherSessions(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	a.remember(`user_id=? AND pub<>?`, u.ID, s.Pub)
	res, err := a.db.Exec(`DELETE FROM sessions WHERE user_id=? AND pub<>?`, u.ID, s.Pub)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		a.audit(u.Email, "signed out other devices", u.Email, "")
	}
	writeJSON(w, 200, map[string]int64{"ended": n})
}

// remember keeps the hashes of sessions about to be signed out from another device (for a year), so such a device
// learns it was signed out on purpose and deletes what it keeps, instead of only asking to sign in again. where
// selects the sessions; it is always a fixed condition, with the values passed as args.
func (a *App) remember(where string, args ...any) {
	now := a.now()
	a.db.Exec(`DELETE FROM revoked_sessions WHERE at < ?`, now.Add(-365*24*time.Hour).Unix())
	a.db.Exec(`INSERT OR IGNORE INTO revoked_sessions(id_hash,at) SELECT id_hash,? FROM sessions WHERE `+where, append([]any{now.Unix()}, args...)...)
}

func (a *App) revoked(token string) bool {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM revoked_sessions WHERE id_hash=?`, sha256hex(token)).Scan(&n)
	return n > 0
}

// claimIndexer makes this device the one that indexes (the person chose it, in the app's search settings).
func (a *App) claimIndexer(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	a.db.Exec(`UPDATE users SET indexer=? WHERE id=?`, s.Pub, u.ID)
	writeJSON(w, 200, map[string]string{"indexer": s.Pub})
}

// dropIndexer: this device stops indexing (search turned off on it); the next device that indexes takes over.
func (a *App) dropIndexer(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	a.db.Exec(`UPDATE users SET indexer='' WHERE id=? AND indexer=?`, u.ID, s.Pub)
	writeJSON(w, 200, map[string]bool{"ok": true})
}
