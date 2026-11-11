package main

import (
	"net/http"
	"strconv"
	"time"
)

// Notices: what the person's devices show once, as a banner, because it may not have been them. A new sign-in (shown
// on the devices that were signed in before it, never on the new one itself), two-step sign-in turned off by an
// administrator (shown on every device, also ones that sign in afterwards: the person who lost their phone signs in
// anew), and, on an account with two-step sign-in, a password step that wasn't followed by a right code (shown on
// every device once it can no longer finish). They arrive through the live-update stream ("notices") and GET /api/me/notices. Dismissing one, on any
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
	// the password of an account with two-step sign-in was used, and no right code followed (passwordUsedNotice)
	noticePasswordUsed = "password_used"
	noticesKept        = 50
	noticesAge         = 90 * 24 * time.Hour
	passwordUsedEvery  = time.Hour // at most one such notice an hour per account
)

// the kinds a notice can have (checked here; the table has no CHECK, so a new kind needs no table rebuild)
var noticeKinds = map[string]bool{noticeSignIn: true, noticeTwoFactorReset: true, noticePasswordUsed: true}

func (a *App) noticeRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/me/notices", a.auth(false, a.listNotices))
	m.HandleFunc("POST /api/me/notices/{id}/dismiss", a.auth(false, a.dismissNotice))
}

// notify stores a notice for the account and tells its devices. pub is the session it is about (not shown there).
func (a *App) notify(userID, kind, device, pub string) {
	a.addNotice(userID, kind, device, pub)
	a.changed(userID, tNotices)
}

// addNotice stores a notice and prunes the account's old ones; it returns the new notice's id (0 if none was stored).
func (a *App) addNotice(userID, kind, device, pub string) int64 {
	if !noticeKinds[kind] {
		return 0
	}
	now := a.now()
	res, err := a.db.Exec(`INSERT INTO notices(user_id,kind,device,session_pub,at) VALUES (?,?,?,?,?)`, userID, kind, device, pub, now.Unix())
	if err != nil {
		return 0
	}
	id, _ := res.LastInsertId()
	// per account the newest noticesKept (ids are shared by all accounts), dismissed ones first to go: they are
	// never shown again
	a.db.Exec(`DELETE FROM notices WHERE user_id=? AND (at < ? OR id NOT IN
		(SELECT id FROM notices WHERE user_id=? ORDER BY dismissed, id DESC LIMIT ?))`,
		userID, now.Add(-noticesAge).Unix(), userID, noticesKept)
	return id
}

// passwordUsedNotice is called when the password step of an account with two-step sign-in succeeded. The notice is
// stored at once but shown only once the pending sign-in can no longer finish (pendingTTL after it was last used);
// a right code deletes it again (dropPasswordUsed). Within passwordUsedEvery of one, the same notice is used again
// (moved to now while it isn't shown yet). It returns the notice's id for the pending sign-in.
func (a *App) passwordUsedNotice(u *user) int64 {
	now := a.now()
	var id, at int64
	err := a.db.QueryRow(`SELECT id, at FROM notices WHERE user_id=? AND kind=? AND at>=? ORDER BY id DESC LIMIT 1`,
		u.ID, noticePasswordUsed, now.Add(-passwordUsedEvery).Unix()).Scan(&id, &at)
	switch {
	case err == nil && at > now.Add(-pendingTTL).Unix():
		a.db.Exec(`UPDATE notices SET at=? WHERE id=?`, now.Unix(), id)
	case err == nil:
		return id // shown already
	default:
		if id = a.addNotice(u.ID, noticePasswordUsed, "", ""); id == 0 {
			return 0
		}
	}
	// the devices hear of it when it is shown; after a restart meanwhile, at their next start
	time.AfterFunc(pendingTTL+2*time.Second, func() {
		var n int
		if a.db.QueryRow(`SELECT COUNT(*) FROM notices WHERE id=?`, id).Scan(&n) == nil && n == 1 {
			a.changed(u.ID, tNotices)
		}
	})
	return id
}

// dropPasswordUsed deletes the notice of a pending sign-in that finished, if no unfinished one shares it and it is
// not shown yet.
func (a *App) dropPasswordUsed(id int64) {
	a.db.Exec(`DELETE FROM notices WHERE id=? AND kind=? AND at>?`, id, noticePasswordUsed, a.now().Add(-pendingTTL).Unix())
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
// An unfinished password step (password_used) is shown to every session once its pending sign-in can't finish.
func (a *App) shownTo(u *user, s *session) (string, []any) {
	return `dismissed=0 AND session_pub<>? AND (kind<>'sign_in' OR (at>=? AND id > COALESCE((SELECT MAX(o.id) FROM notices o
		WHERE o.user_id=? AND o.kind='sign_in' AND o.session_pub=? AND o.session_pub<>''), 0)))
		AND (kind<>'password_used' OR at<=?)`, []any{s.Pub, s.Created, u.ID, s.Pub, a.now().Add(-pendingTTL).Unix()}
}

func (a *App) listNotices(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	out := []map[string]any{}
	if a.isDemo(u) {
		writeJSON(w, 200, map[string]any{"notices": out})
		return
	}
	// a sign-in is news only to devices that were signed in before it; an admin's reset to every device
	cond, args := a.shownTo(u, s)
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
	cond, args := a.shownTo(u, s)
	res, err := a.db.Exec(`UPDATE notices SET dismissed=1 WHERE id=? AND user_id=? AND `+cond, append([]any{id, u.ID}, args...)...)
	if rowsAffected(res, err) != 1 {
		fail(w, 404, "not found")
		return
	}
	a.changed(u.ID, tNotices) // the other devices take it down too
	writeJSON(w, 200, map[string]bool{"ok": true})
}
