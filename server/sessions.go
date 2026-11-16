package main

import (
	"net/http"
	"regexp"
	"slices"
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
	m.HandleFunc("POST /api/me/sessions/end-unused", a.auth(false, a.endUnusedSessions))
	m.HandleFunc("PUT /api/me/device-idle", a.auth(false, a.setDeviceIdle))
	m.HandleFunc("POST /api/me/sessions/current/last-upload", a.auth(false, a.backfillLastUpload))
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
	case strings.HasPrefix(ua, "cipherfilm-upload/"):
		return "Upload tool"
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
	now := a.now().Unix()
	a.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE pub=? AND user_id=? AND expires_at>=? AND last_seen>=?`, u.Indexer, u.ID, now, now-idleLimit(u.IdleDays)).Scan(&n)
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
	now := a.now().Unix()
	res, err := a.db.Exec(`UPDATE users SET indexer=? WHERE id=? AND (indexer='' OR indexer=? OR NOT EXISTS (SELECT 1 FROM sessions WHERE pub=users.indexer AND user_id=users.id AND expires_at>=? AND last_seen>=?))`,
		s.Pub, u.ID, s.Pub, now, now-idleLimit(u.IdleDays))
	if rowsAffected(res, err) == 1 {
		u.Indexer = s.Pub
		return true
	}
	return false
}

func (a *App) listSessions(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	// a public demo account is shared by strangers: each sees only its own device, not the others' names
	only := ""
	if a.isDemo(u) {
		only = s.Pub
	}
	rows, err := a.db.Query(`SELECT pub,device,created_at,last_seen FROM sessions WHERE user_id=? AND expires_at>=? AND (?='' OR pub=?) ORDER BY last_seen DESC`, u.ID, a.now().Unix(), only, only)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer rows.Close()
	indexer := a.liveIndexer(u)
	now, limit := a.now().Unix(), idleLimit(u.IdleDays)
	out := []map[string]any{}
	for rows.Next() {
		var pub, device string
		var created, seen int64
		if rows.Scan(&pub, &device, &created, &seen) == nil {
			// unused: signed out the next time it connects, or now with "Sign out unused devices" (endUnusedSessions)
			out = append(out, map[string]any{"id": pub, "device": device, "created_at": created, "last_seen": seen,
				"current": pub == s.Pub, "indexer": pub == indexer, "unused": pub != s.Pub && now-seen > limit})
		}
	}
	writeJSON(w, 200, map[string]any{"sessions": out, "idle_days": idleDays(u.IdleDays)})
}

// Devices not used for a while are signed out: after 30 days without a request, or after 7 or 14 if the person chose
// that (PUT /api/me/device-idle). They are signed out as from another device (remember), so a lost phone or a
// forgotten browser deletes what it keeps when it comes back, instead of only asking to sign in again.
var idleChoices = []int{7, 14, 30}

// idleDays is the account's choice, or 30 days for a value that isn't one of the choices.
func idleDays(d int) int {
	if slices.Contains(idleChoices, d) {
		return d
	}
	return int(sessionIdle.Hours() / 24)
}

// idleLimit is how long, in seconds, a device of an account with this choice may go unused.
func idleLimit(d int) int64 { return int64(idleDays(d)) * 24 * 3600 }

func (a *App) setDeviceIdle(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req struct {
		Days int `json:"days"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !slices.Contains(idleChoices, req.Days) {
		fail(w, 400, "choose 7, 14 or 30 days")
		return
	}
	a.db.Exec(`UPDATE users SET device_idle_days=? WHERE id=?`, req.Days, u.ID)
	writeJSON(w, 200, map[string]int{"idle_days": req.Days})
}

// endUnusedSessions signs out the account's other devices that have gone unused for longer than its limit now,
// rather than when they next connect; never this one. The answer is how many.
func (a *App) endUnusedSessions(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	before := a.now().Unix() - idleLimit(u.IdleDays)
	const where = `user_id=? AND pub<>? AND last_seen<?`
	rows, err := a.db.Query(`SELECT pub FROM sessions WHERE `+where, u.ID, s.Pub, before)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	var pubs []string
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			pubs = append(pubs, p)
		}
	}
	rows.Close()
	a.remember(where, u.ID, s.Pub, before)
	res, err := a.db.Exec(`DELETE FROM sessions WHERE `+where, u.ID, s.Pub, before)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	n, _ := res.RowsAffected()
	for _, p := range pubs {
		a.dropInvitesOf(u.ID, `created_session=?`, p)
	}
	if n > 0 {
		a.live.recheck(u.ID)
		a.audit(u.Email, "signed out unused devices", u.Email, "")
	}
	writeJSON(w, 200, map[string]int64{"ended": n})
}

// backfillLastUpload: the time of this device's newest upload as the app remembers it, for a session that has none
// recorded (the server only notes uploads since the storage overview came, so it had nothing to show). Only for this
// session, and only once: a recorded time, the app's or the server's own (markUploaded), is never changed. The time is
// kept within the last year and never in the future. It is only a time, as markUploaded keeps.
func (a *App) backfillLastUpload(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req struct {
		At int64 `json:"at"` // seconds
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.At <= 0 {
		fail(w, 400, "invalid request")
		return
	}
	now := a.now().Unix()
	at := min(max(req.At, now-365*24*3600), now)
	res, err := a.db.Exec(`UPDATE sessions SET last_upload_at=? WHERE id_hash=? AND last_upload_at=0`, at, s.IDHash)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	var stored int64
	a.db.QueryRow(`SELECT last_upload_at FROM sessions WHERE id_hash=?`, s.IDHash).Scan(&stored)
	writeJSON(w, 200, map[string]any{"set": rowsAffected(res, nil) == 1, "last_upload_at": stored})
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
	a.live.recheck(u.ID)
	a.dropInvitesOf(u.ID, `created_session=?`, id)
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
	a.live.recheck(u.ID)
	a.dropInvitesOf(u.ID, `created_session<>?`, s.Pub)
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

// toRevoke and revokeLater are remember in two halves, for sessions ended inside a transaction that may still fail (a
// password change, a recovery): the hashes are read before it and kept only once it committed, so a device whose
// session survives a failed change isn't later told it was signed out on purpose.
func (a *App) toRevoke(where string, args ...any) []string {
	rows, err := a.db.Query(`SELECT id_hash FROM sessions WHERE `+where, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var h string
		if rows.Scan(&h) == nil {
			out = append(out, h)
		}
	}
	return out
}

func (a *App) revokeLater(hashes []string) {
	now := a.now()
	a.db.Exec(`DELETE FROM revoked_sessions WHERE at < ?`, now.Add(-365*24*time.Hour).Unix())
	for _, h := range hashes {
		a.db.Exec(`INSERT OR IGNORE INTO revoked_sessions(id_hash,at) VALUES(?,?)`, h, now.Unix())
	}
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
