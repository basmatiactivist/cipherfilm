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
// device that is shown it, dismisses it for the account. Only what the session list already shows is stored: the
// device's own label and the time; never an IP address or a place.
//
// Who is shown, and so may dismiss, a notice (shownTo): never the session it is about, and a sign-in only the sessions
// from before it. "Before" is the order of the sign-in notices themselves (ids), not the second a session started:
// two sign-ins in the same second would otherwise each be shown, and could take down, the other's. So someone who
// signs in with a stolen password can't dismiss the notice about that sign-in, from that session or any later one;
// what the real person's devices show of it goes only when one of them dismisses it (or after noticesKept newer ones
// or noticesAge). Limits: a session can dismiss the notices about every later sign-in, also later ones of the same
// person (it can't tell them apart), and an administrator's reset is shown to, and dismissable by, every session.

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
	// per account the newest noticesKept (ids are shared by all accounts), dismissed ones first to go: they are
	// never shown again
	a.db.Exec(`DELETE FROM notices WHERE user_id=? AND (at < ? OR id NOT IN
		(SELECT id FROM notices WHERE user_id=? ORDER BY dismissed, id DESC LIMIT ?))`,
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

// shownTo is the condition for the notices the session s is shown, with its arguments (after the notice's user_id).
func shownTo(u *user, s *session) (string, []any) {
	return `dismissed=0 AND session_pub<>? AND (kind<>'sign_in' OR (at>=? AND id > COALESCE((SELECT MAX(o.id) FROM notices o
		WHERE o.user_id=? AND o.kind='sign_in' AND o.session_pub=? AND o.session_pub<>''), 0)))`, []any{s.Pub, s.Created, u.ID, s.Pub}
}

func (a *App) listNotices(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	out := []map[string]any{}
	if a.isDemo(u) {
		writeJSON(w, 200, map[string]any{"notices": out})
		return
	}
	// a sign-in is news only to devices that were signed in before it; an admin's reset to every device
	cond, args := shownTo(u, s)
	rows, err := a.db.Query(`SELECT id,kind,device,at FROM notices WHERE user_id=? AND `+cond+` ORDER BY id DESC LIMIT 20`,
		append([]any{u.ID}, args...)...)
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
	// only one this session is shown (shownTo)
	cond, args := shownTo(u, s)
	res, err := a.db.Exec(`UPDATE notices SET dismissed=1 WHERE id=? AND user_id=? AND `+cond, append([]any{id, u.ID}, args...)...)
	if rowsAffected(res, err) != 1 {
		fail(w, 404, "not found")
		return
	}
	a.changed(u.ID, tNotices) // the other devices take it down too
	writeJSON(w, 200, map[string]bool{"ok": true})
}
