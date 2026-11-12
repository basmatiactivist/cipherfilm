package main

import (
	"database/sql"
	"net/http"
	"strconv"
)

func (a *App) adminListUsers(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	rows, err := a.db.Query(`SELECT u.id,u.email,u.role,u.status,u.created_at,u.quota_bytes,
		` + usedBytesSQL("u.id") + `,
		(SELECT COUNT(*) FROM items i WHERE i.user_id=u.id AND i.state='ready'), u.last_login_at, u.nsfw, (u.totp_secret<>'' OR EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id=u.id))
		FROM users u ORDER BY u.created_at`)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer rows.Close()
	type row struct {
		ID, Email, Role, Status string
		CreatedAt, LastLogin    int64
		Quota, Used, Count      int64
		NSFW, TwoFactor         bool
	}
	out := []map[string]any{}
	for rows.Next() {
		var x row
		if rows.Scan(&x.ID, &x.Email, &x.Role, &x.Status, &x.CreatedAt, &x.Quota, &x.Used, &x.Count, &x.LastLogin, &x.NSFW, &x.TwoFactor) == nil {
			// sizes and counts are metadata the server knows anyway; names, albums and content stay private
			out = append(out, map[string]any{"id": x.ID, "email": x.Email, "role": x.Role, "status": x.Status, "created_at": x.CreatedAt, "quota_bytes": x.Quota, "used_bytes": x.Used, "item_count": x.Count, "last_login_at": x.LastLogin, "nsfw": x.NSFW, "two_factor": x.TwoFactor})
		}
	}
	inv, err := a.db.Query(`SELECT id,email,expires_at,quota_bytes FROM invites WHERE used_at IS NULL AND expires_at > ? AND `+inviteCreatorOK+` ORDER BY created_at`, a.now().Unix())
	invites := []map[string]any{}
	defQuota := a.defaultQuota()
	if err == nil {
		defer inv.Close()
		for inv.Next() {
			var id, email string
			var exp int64
			var q sql.NullInt64
			if inv.Scan(&id, &email, &exp, &q) == nil {
				invites = append(invites, map[string]any{"id": id, "email": email, "expires_at": exp, "quota_bytes": inviteQuota(q, defQuota)})
			}
		}
	}
	writeJSON(w, 200, map[string]any{"users": out, "invites": invites, "default_quota_bytes": a.defaultQuota()})
}

type inviteReq struct {
	Email      string `json:"email"`
	QuotaBytes *int64 `json:"quota_bytes"` // optional; 0 = unlimited, omitted = server default
}

func (a *App) adminCreateInvite(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req inviteReq
	if !readJSON(w, r, &req) {
		return
	}
	email, ok := normEmail(req.Email)
	if !ok {
		fail(w, 400, "invalid e-mail")
		return
	}
	if _, err := a.userByEmail(email); err == nil {
		fail(w, 409, "an account with this e-mail already exists")
		return
	}
	if req.QuotaBytes != nil && (*req.QuotaBytes < 0 || *req.QuotaBytes > 1<<50) {
		fail(w, 400, "invalid storage limit")
		return
	}
	var quota any // NULL = whatever the default is when the person joins
	if req.QuotaBytes != nil {
		quota = *req.QuotaBytes
	}
	tok := randToken()
	exp := a.now().Add(inviteTTL).Unix()
	// a new invite replaces any open one for the same address
	a.db.Exec(`DELETE FROM invites WHERE email=? AND used_at IS NULL`, email)
	if _, err := a.db.Exec(`INSERT INTO invites(id,token_hash,email,created_by,created_at,expires_at,quota_bytes,created_session) VALUES (?,?,?,?,?,?,?,?)`,
		randID(), sha256hex(tok), email, u.ID, a.now().Unix(), exp, quota, s.Pub); err != nil {
		fail(w, 500, "server error")
		return
	}
	a.audit(u.Email, "invited", email, "")
	writeJSON(w, 201, map[string]any{"token": tok, "email": email, "expires_at": exp})
}

type patchReq struct {
	Status     *string `json:"status"`
	QuotaBytes *int64  `json:"quota_bytes"` // 0 = unlimited
	Role       *string `json:"role"`        // "admin" or "user"
	NSFW       *bool   `json:"nsfw"`        // search of explicit content allowed
}

// adminGuard serialises administrative changes to accounts and re-checks, under the lock, that the caller is still an
// active administrator and that the change would not remove the last one. Without it, two admins who act on each other
// at the same moment both pass the per-request role check and can leave the server with no administrator.
// keepsAdmin holds for a row whose change or removal still leaves an active administrator. In the UPDATE or DELETE
// itself it makes the rule atomic, also when the console and the web change accounts at the same moment.
const keepsAdmin = `(role<>'admin' OR status<>'active' OR EXISTS (SELECT 1 FROM users o WHERE o.role='admin' AND o.status='active' AND o.id<>users.id))`

func (a *App) adminGuard(w http.ResponseWriter, caller *user, target *user, removesAdmin bool) bool {
	cur, err := a.userByID(caller.ID)
	if err != nil || cur.Role != "admin" || cur.Status != "active" {
		fail(w, http.StatusNotFound, "not found")
		return false
	}
	if removesAdmin && target.Role == "admin" && target.Status == "active" {
		var others int
		a.db.QueryRow(`SELECT COUNT(*) FROM users WHERE role='admin' AND status='active' AND id<>?`, target.ID).Scan(&others)
		if others < 1 {
			fail(w, http.StatusConflict, "at least one active administrator must remain")
			return false
		}
	}
	return true
}

func (a *App) adminPatchUser(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	id := r.PathValue("id")
	var req patchReq
	if !readJSON(w, r, &req) {
		return
	}
	// an admin may allow or forbid explicit search for themselves too, but not change their own role, status or limit
	if id == u.ID && (req.Status != nil || req.QuotaBytes != nil || req.Role != nil) {
		fail(w, 400, "you can't change your own role, status or limit")
		return
	}
	if (req.Status == nil && req.QuotaBytes == nil && req.Role == nil && req.NSFW == nil) || (req.Role != nil && *req.Role != "admin" && *req.Role != "user") || (req.Status != nil && *req.Status != "active" && *req.Status != "disabled") || (req.QuotaBytes != nil && (*req.QuotaBytes < 0 || *req.QuotaBytes > 1<<50)) {
		fail(w, 400, "invalid request")
		return
	}
	a.adminMu.Lock()
	defer a.adminMu.Unlock()
	target, err := a.userByID(id)
	if err != nil {
		fail(w, 404, "not found")
		return
	}
	demotes := (req.Status != nil && *req.Status == "disabled") || (req.Role != nil && *req.Role == "user")
	if !a.adminGuard(w, u, target, demotes) {
		return
	}
	if req.NSFW != nil && *req.NSFW != target.NSFW {
		a.db.Exec(`UPDATE users SET nsfw=? WHERE id=?`, *req.NSFW, id)
		a.audit(u.Email, map[bool]string{true: "explicit search allowed", false: "explicit search turned off"}[*req.NSFW], target.Email, "")
	}
	if req.Status != nil {
		res, err := a.db.Exec(`UPDATE users SET status=? WHERE id=? AND (?='active' OR `+keepsAdmin+`)`, *req.Status, id, *req.Status)
		if rowsAffected(res, err) != 1 {
			fail(w, http.StatusConflict, "at least one active administrator must remain")
			return
		}
		a.audit(u.Email, map[string]string{"active": "enabled", "disabled": "disabled"}[*req.Status], target.Email, "")
		if *req.Status == "disabled" {
			a.db.Exec(`DELETE FROM sessions WHERE user_id=?`, id)
			a.revokeTickets(id)
			a.live.recheck(id)
		}
	}
	if req.QuotaBytes != nil {
		a.db.Exec(`UPDATE users SET quota_bytes=? WHERE id=?`, *req.QuotaBytes, id)
		a.audit(u.Email, "storage limit changed", target.Email, strconv.FormatInt(*req.QuotaBytes, 10))
	}
	if req.Role != nil && *req.Role != target.Role {
		// the calling admin is never the target (checked above), so at least one admin always remains
		q := int64(0) // admins have no limit; someone moved back to "user" gets the default
		if *req.Role == "user" {
			q = a.defaultQuota()
		}
		if req.QuotaBytes != nil {
			q = *req.QuotaBytes // an explicit limit in the same request wins
		}
		res, err := a.db.Exec(`UPDATE users SET role=?, quota_bytes=? WHERE id=? AND (?='admin' OR `+keepsAdmin+`)`, *req.Role, q, id, *req.Role)
		if rowsAffected(res, err) != 1 {
			fail(w, http.StatusConflict, "at least one active administrator must remain")
			return
		}
		a.audit(u.Email, "role changed", target.Email, *req.Role)
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) adminDeleteUser(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	id := r.PathValue("id")
	if id == u.ID {
		fail(w, 400, "delete your own account under Account")
		return
	}
	a.adminMu.Lock()
	defer a.adminMu.Unlock()
	victim, verr := a.userByID(id)
	if verr != nil {
		fail(w, 404, "not found")
		return
	}
	if !a.adminGuard(w, u, victim, true) {
		return
	}
	ids := a.itemIDs(id)
	res, err := a.db.Exec(`DELETE FROM users WHERE id=? AND `+keepsAdmin, id)
	if rowsAffected(res, err) != 1 {
		fail(w, http.StatusConflict, "at least one active administrator must remain")
		return
	}
	for _, it := range ids {
		a.removeBlobs(it)
	}
	a.live.recheck(id)
	forgetEmail(a.db, victim.Email)
	a.audit(u.Email, "deleted", victim.Email, "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// adminRevokeInvite withdraws an open invite so its link stops working.
func (a *App) adminRevokeInvite(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var who string
	a.db.QueryRow(`SELECT email FROM invites WHERE id=? AND used_at IS NULL`, r.PathValue("id")).Scan(&who)
	res, err := a.db.Exec(`DELETE FROM invites WHERE id=? AND used_at IS NULL`, r.PathValue("id"))
	if rowsAffected(res, err) != 1 {
		fail(w, 404, "not found")
		return
	}
	a.audit(u.Email, "invite revoked", who, "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}
