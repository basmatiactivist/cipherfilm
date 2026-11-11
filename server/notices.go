package main

import (
	"net/http"
	"strconv"
	"time"
)

// Notices: what the person's devices show once, as a banner, because it may not have been them. A new sign-in (shown
// on the devices that were signed in before it, never on the new one itself) and two-step sign-in turned off by an
// administrator (shown on every device, also ones that sign in afterwards: the person who lost their phone signs in
// anew). They arrive through the live-update stream ("notices") and GET /api/me/notices. Dismissing one, on any
// device, dismisses it for the account. Only what the session list already shows is stored: the device's own label
// and the time; never an IP address or a place.

const (
	noticeSignIn         = "sign_in"
	noticeTwoFactorReset = "2fa_reset"
	noticesKept          = 50
	noticesAge           = 90 * 24 * time.Hour
)

func (a *App) noticeRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/me/notices", a.auth(false, a.listNotices))
	m.HandleFunc("POST /api/me/notices/{id}/dismiss", a.auth(false, a.dismissNotice))
}

// notify stores a notice for the account and tells its devices. pub is the session it is about (not shown there).
func (a *App) notify(userID, kind, device, pub string) {
	now := a.now()
	a.db.Exec(`INSERT INTO notices(user_id,kind,device,session_pub,at) VALUES (?,?,?,?,?)`, userID, kind, device, pub, now.Unix())
	a.db.Exec(`DELETE FROM notices WHERE user_id=? AND (at < ? OR id <= (SELECT MAX(id) FROM notices WHERE user_id=?) - ?)`,
		userID, now.Add(-noticesAge).Unix(), userID, noticesKept)
	a.changed(userID, tNotices)
}

// noticeSignIn tells the account's other devices about a new sign-in. A public demo login is shared by strangers:
// none there.
func (a *App) noticeSignIn(u *user, s *session, r *http.Request) {
	if a.isDemo(u) {
		return
	}
	a.notify(u.ID, noticeSignIn, deviceName(r), s.Pub)
}

func (a *App) listNotices(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	out := []map[string]any{}
	if a.isDemo(u) {
		writeJSON(w, 200, map[string]any{"notices": out})
		return
	}
	// a sign-in is news only to devices that were signed in before it; an admin's reset to every device
	rows, err := a.db.Query(`SELECT id,kind,device,at FROM notices WHERE user_id=? AND dismissed=0 AND session_pub<>?
		AND (kind<>'sign_in' OR at>=?) ORDER BY id DESC LIMIT 20`, u.ID, s.Pub, s.Created)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id, at int64
		var kind, device string
		if rows.Scan(&id, &kind, &device, &at) == nil {
			out = append(out, map[string]any{"id": id, "kind": kind, "device": device, "at": at})
		}
	}
	writeJSON(w, 200, map[string]any{"notices": out})
}

func (a *App) dismissNotice(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		fail(w, 404, "not found")
		return
	}
	res, err := a.db.Exec(`UPDATE notices SET dismissed=1 WHERE id=? AND user_id=?`, id, u.ID)
	if rowsAffected(res, err) != 1 {
		fail(w, 404, "not found")
		return
	}
	a.changed(u.ID, tNotices) // the other devices take it down too
	writeJSON(w, 200, map[string]bool{"ok": true})
}
