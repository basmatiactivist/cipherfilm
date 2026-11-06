package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (a *App) routes() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("ok"))
	})
	m.HandleFunc("GET /api/setup/status", a.setupStatus)
	m.HandleFunc("POST /api/setup", a.setup)
	m.HandleFunc("GET /api/auth/params", a.authParams)
	m.HandleFunc("POST /api/auth/login", a.login)
	m.HandleFunc("POST /api/auth/logout", a.auth(false, a.logout))
	m.HandleFunc("GET /api/me", a.auth(false, a.me))
	m.HandleFunc("POST /api/auth/password", a.auth(false, a.changePassword))
	m.HandleFunc("DELETE /api/me", a.auth(false, a.deleteMe))
	m.HandleFunc("POST /api/auth/recovery-key", a.auth(false, a.newRecoveryKey))
	m.HandleFunc("GET /api/me/usage", a.auth(false, a.usage))
	m.HandleFunc("POST /api/auth/recover/start", a.recoverStart)
	m.HandleFunc("POST /api/auth/recover/finish", a.recoverFinish)
	m.HandleFunc("GET /api/invites/{token}", a.inviteInfo)
	m.HandleFunc("POST /api/invites/{token}/accept", a.inviteAccept)
	a.itemRoutes(m)
	a.albumRoutes(m)
	a.indexRoutes(m)
	a.sessionRoutes(m)
	a.thumbRoutes(m)
	m.HandleFunc("GET /api/admin/users", a.auth(true, a.adminListUsers))
	m.HandleFunc("DELETE /api/admin/invites/{id}", a.auth(true, a.adminRevokeInvite))
	m.HandleFunc("PATCH /api/admin/settings", a.auth(true, a.adminPatchSettings))
	m.HandleFunc("GET /api/admin/audit", a.auth(true, a.adminAudit))
	m.HandleFunc("GET /api/admin/status", a.auth(true, a.adminStatus))
	m.HandleFunc("POST /api/admin/invites", a.auth(true, a.adminCreateInvite))
	m.HandleFunc("PATCH /api/admin/users/{id}", a.auth(true, a.adminPatchUser))
	m.HandleFunc("DELETE /api/admin/users/{id}", a.auth(true, a.adminDeleteUser))
	return sameOrigin(m)
}

type userView struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Role  string `json:"role"`
	// the admin allows this person search of explicit content: the apps then offer it (and its model) in settings
	NSFW bool `json:"nsfw"`
}

// sessionBundle is what a signed-in client needs to unlock its keys.
func (a *App) sessionBundle(u *user, s *session) map[string]any {
	return map[string]any{
		"user":              userView{u.ID, u.Email, u.Role, u.NSFW},
		"csrf":              s.CSRF,
		"session_id":        s.Pub,            // this device in the device list
		"indexer":           a.liveIndexer(u), // the device that computes the search index ("" = none yet)
		"kdf":               json.RawMessage(u.KDF),
		"wrapped_master_pw": u.WrappedMasterPW,
		"wrapped_privkey":   u.WrappedPrivkey,
		"pubkey":            u.Pubkey,
		"server_version":    version, // shown in the apps' settings
	}
}

// ---- setup ----

func (a *App) setupStatus(w http.ResponseWriter, r *http.Request) {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM setup_state`).Scan(&n)
	// the version is public anyway (the sign-in screen shows it), so it is no secret worth a login
	writeJSON(w, 200, map[string]any{"needs_setup": n > 0, "server_version": version})
}

type setupReq struct {
	SetupToken string `json:"setup_token"`
	Email      string `json:"email"`
	keyBundle
}

func (a *App) setup(w http.ResponseWriter, r *http.Request) {
	ip := "setup|" + limiterIP(a.clientIP(r))
	if !a.loginIP.allowed(ip) {
		fail(w, 429, "too many attempts, try later")
		return
	}
	var req setupReq
	if !readJSON(w, r, &req) {
		return
	}
	email, ok := normEmail(req.Email)
	if !ok || req.validate() != nil {
		fail(w, 400, "invalid request")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	var want string
	// only while there is no account yet: one made on the console first ends the setup, even before a restart
	if err := tx.QueryRow(`SELECT token_hash FROM setup_state WHERE id=1 AND NOT EXISTS (SELECT 1 FROM users)`).Scan(&want); err != nil {
		fail(w, 404, "setup is already complete")
		return
	}
	if !ctEqual(sha256hex(req.SetupToken), want) {
		a.loginIP.fail(ip)
		fail(w, 403, "wrong setup token")
		return
	}
	id, err := insertUser(r.Context(), tx, email, "admin", 0, req.keyBundle, a.now())
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if _, err := tx.Exec(`DELETE FROM setup_state`); err != nil {
		fail(w, 500, "server error")
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, 500, "server error")
		return
	}
	ss, err := a.startSession(w, r, id, "")
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	u, _ := a.userByID(id)
	writeJSON(w, 201, a.sessionBundle(u, ss))
}

// ---- login ----

// fakeParams are deterministic per e-mail so unknown accounts look like real ones.
func (a *App) fakeParams(email string) kdfParams {
	return kdfParams{Alg: "argon2id13", V: 1, Ops: 3, Mem: 64 << 20, Salt: b64.EncodeToString(hmacSum(a.secret, "fakesalt|"+email)[:16])}
}

func (a *App) authParams(w http.ResponseWriter, r *http.Request) {
	email, ok := normEmail(r.URL.Query().Get("email"))
	if !ok {
		fail(w, 400, "invalid request")
		return
	}
	if u, err := a.userByEmail(email); err == nil {
		writeJSON(w, 200, json.RawMessage(u.KDF))
		return
	}
	writeJSON(w, 200, a.fakeParams(email))
}

type loginReq struct {
	Email string `json:"email"`
	Auth  string `json:"auth"`
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if !readJSON(w, r, &req) {
		return
	}
	email, ok := normEmail(req.Email)
	if !ok {
		fail(w, 400, "invalid request")
		return
	}
	// The attempt is counted before the Argon2 check, so concurrent guesses cannot exceed the caps. The account
	// bucket is keyed by (account, source): failures from one source never lock the real user out from another.
	ip := limiterIP(a.clientIP(r))
	u, err := a.userByEmail(email)
	slots := []slot{{a.loginIP, "login|" + ip, false}, {a.loginAcct, "login|" + email + "|" + ip, true}}
	known := err == nil && a.knownDevice(r, u)
	if known {
		// a browser that signed in before is limited per account, not per source (see device.go)
		slots = []slot{{a.loginDev, "login|" + u.ID, true}}
	}
	at, ok := reserve(slots...)
	if !ok {
		fail(w, 429, "too many attempts, try later")
		return
	}
	hash := a.dummyHash
	if err == nil {
		hash = u.AuthHash
	}
	good, busy := verifySecretCtx(r.Context(), !known, hash, req.Auth)
	if busy != nil {
		at.refund()
		failBusy(w)
		return
	}
	if !(good && err == nil && u.Status == "active") {
		fail(w, 401, "wrong e-mail or password")
		return
	}
	at.success()
	ss, err := a.startSession(w, r, u.ID, u.AuthHash)
	if errors.Is(err, errCredentialsChanged) {
		fail(w, 401, "wrong e-mail or password")
		return
	}
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	writeJSON(w, 200, a.sessionBundle(u, ss))
}

// failBusy answers a credential check that could not get its turn (or whose client has gone).
func failBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	fail(w, 503, "the server is busy, try again in a moment")
}

func (a *App) logout(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	a.db.Exec(`DELETE FROM sessions WHERE id_hash=?`, s.IDHash)
	clearCookie(w)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) me(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	writeJSON(w, 200, a.sessionBundle(u, s))
}

// ---- password change ----

type changeReq struct {
	CurrentAuth        string    `json:"current_auth"`
	NewAuth            string    `json:"new_auth"`
	NewKDF             kdfParams `json:"new_kdf"`
	NewWrappedMasterPW string    `json:"new_wrapped_master_pw"`
}

func (a *App) changePassword(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req changeReq
	if !readJSON(w, r, &req) {
		return
	}
	at, ok := reserve(slot{a.loginAcct, "pwchange|" + u.ID, true})
	if !ok {
		fail(w, 429, "too many attempts, try later")
		return
	}
	if !verifySecret(u.AuthHash, req.CurrentAuth) {
		fail(w, 403, "current password is wrong")
		return
	}
	if req.NewKDF.validate() != nil || checkLen(req.NewAuth, 32) != nil || checkLen(req.NewWrappedMasterPW, wrappedLen) != nil {
		fail(w, 400, "invalid request")
		return
	}
	ah, err := hashSecret(req.NewAuth)
	if err != nil {
		fail(w, 400, "invalid request")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	// only if the password is still the one just checked: when two devices change it at the same moment, the second
	// would otherwise overwrite the first and leave a password that neither person typed last
	res, err := tx.Exec(`UPDATE users SET kdf=?, auth_hash=?, wrapped_master_pw=? WHERE id=? AND auth_hash=? AND status='active'`, req.NewKDF.json(), ah, req.NewWrappedMasterPW, u.ID, u.AuthHash)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if rowsAffected(res, err) != 1 {
		fail(w, 409, "your password was just changed on another device; sign in again with the new one")
		return
	}
	// sign out every other session
	if _, err := tx.Exec(`DELETE FROM sessions WHERE user_id=? AND id_hash<>?`, u.ID, s.IDHash); err != nil {
		fail(w, 500, "server error")
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, 500, "server error")
		return
	}
	at.success()
	a.revokeTickets(u.ID)
	if nu, err := a.userByID(u.ID); err == nil {
		a.setDevice(w, nu) // the old device cookie is bound to the old password hash
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---- deleting one's own account ----

type deleteMeReq struct {
	CurrentAuth string `json:"current_auth"`
}

// deleteMe deletes the signed-in account permanently, with the same proof as a password change: its photos and videos,
// albums, search index, people and every session (the other devices learn they were signed out on purpose and wipe
// what they keep). The last active administrator can't: someone else must be made administrator first.
func (a *App) deleteMe(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req deleteMeReq
	if !readJSON(w, r, &req) {
		return
	}
	at, ok := reserve(slot{a.loginAcct, "delete|" + u.ID, true})
	if !ok {
		fail(w, 429, "too many attempts, try later")
		return
	}
	if !verifySecret(u.AuthHash, req.CurrentAuth) {
		fail(w, 403, "that password isn't right")
		return
	}
	// with the admin changes: an admin deleting or demoting the other one at the same moment must not leave none
	a.adminMu.Lock()
	defer a.adminMu.Unlock()
	if cur, err := a.userByID(u.ID); err == nil && lastAdmin(a, cur) {
		at.success()
		fail(w, http.StatusConflict, "you are the only administrator: make someone else an administrator first, then delete your account")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	var ids []string
	rows, err := tx.Query(`SELECT id FROM items WHERE user_id=?`, u.ID)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	// so the other devices learn they were signed out on purpose (not only that the session ended) and wipe their copy;
	// this one wipes its own when the answer comes
	if _, err := tx.Exec(`INSERT OR IGNORE INTO revoked_sessions(id_hash,at) SELECT id_hash,? FROM sessions WHERE user_id=? AND id_hash<>?`, a.now().Unix(), u.ID, s.IDHash); err != nil {
		fail(w, 500, "server error")
		return
	}
	// only with the password just checked (a change or recovery meanwhile wins), and never the last active admin
	res, err := tx.Exec(`DELETE FROM users WHERE id=? AND auth_hash=? AND `+keepsAdmin, u.ID, u.AuthHash)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if rowsAffected(res, err) != 1 {
		fail(w, 409, "your password or role was just changed; sign in again and try once more")
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, 500, "server error")
		return
	}
	at.success()
	for _, id := range ids {
		a.removeBlobs(id)
	}
	a.revokeTickets(u.ID)
	a.audit(u.Email, "deleted own account", u.Email, strconv.Itoa(len(ids))+" items")
	clearCookie(w)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---- recovery key rotation ----

type newRecKeyReq struct {
	CurrentAuth           string `json:"current_auth"`
	WrappedMasterRecovery string `json:"wrapped_master_recovery"`
	RecoveryVerifier      string `json:"recovery_verifier"`
}

// newRecoveryKey replaces the account's recovery key: the browser made a new key, wrapped the master key
// under it and sends only the wrap and a verifier. The old recovery key stops working at once.
func (a *App) newRecoveryKey(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req newRecKeyReq
	if !readJSON(w, r, &req) {
		return
	}
	at, ok := reserve(slot{a.loginAcct, "newreckey|" + u.ID, true})
	if !ok {
		fail(w, 429, "too many attempts, try later")
		return
	}
	if !verifySecret(u.AuthHash, req.CurrentAuth) {
		fail(w, 403, "that password isn't right")
		return
	}
	if checkLen(req.WrappedMasterRecovery, wrappedLen) != nil || checkLen(req.RecoveryVerifier, 32) != nil {
		fail(w, 400, "invalid request")
		return
	}
	rh, err := hashSecret(req.RecoveryVerifier)
	if err != nil {
		fail(w, 400, "invalid request")
		return
	}
	// only while the password and the session that authorised this are still current: a recovery, password change or
	// sign-out that ran meanwhile has ended the session, and must not be undone by a request that was already on its way
	res, err := a.db.Exec(`UPDATE users SET wrapped_master_recovery=?, recovery_hash=? WHERE id=? AND auth_hash=? AND status='active'
		AND EXISTS (SELECT 1 FROM sessions WHERE id_hash=? AND user_id=?)`, req.WrappedMasterRecovery, rh, u.ID, u.AuthHash, s.IDHash, u.ID)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if rowsAffected(res, nil) != 1 {
		fail(w, 401, "your session ended, sign in again")
		return
	}
	at.success()
	a.revokeTickets(u.ID)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) usage(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var quota, used int64
	a.db.QueryRow(`SELECT quota_bytes FROM users WHERE id=?`, u.ID).Scan(&quota)
	a.db.QueryRow(`SELECT `+usedBytesSQL("?"), u.ID, u.ID, u.ID).Scan(&used)
	writeJSON(w, 200, map[string]any{"used_bytes": used, "quota_bytes": quota, "unlimited": quota == 0})
}

// ---- recovery ----

type recoverStartReq struct {
	Email        string `json:"email"`
	RecoveryAuth string `json:"recovery_auth"`
}

// A ticket is bound to the recovery key it was opened with: if that key is replaced in the meantime (a rotation that
// ran while this one was being checked), the ticket can no longer finish.
type ticket struct {
	userID  string
	recHash string
	expires time.Time
}

func (a *App) recoverStart(w http.ResponseWriter, r *http.Request) {
	var req recoverStartReq
	if !readJSON(w, r, &req) {
		return
	}
	email, ok := normEmail(req.Email)
	if !ok {
		fail(w, 400, "invalid request")
		return
	}
	ip := limiterIP(a.clientIP(r))
	u, err := a.userByEmail(email)
	slots := []slot{{a.loginIP, "recover|" + ip, false}, {a.loginAcct, "recover|" + email + "|" + ip, true}}
	known := err == nil && a.knownDevice(r, u)
	if known {
		// like login: a browser that signed in before is limited per account, not per source
		slots = []slot{{a.loginDev, "recover|" + u.ID, true}}
	}
	at, ok := reserve(slots...)
	if !ok {
		fail(w, 429, "too many attempts, try later")
		return
	}
	hash := a.dummyHash
	if err == nil {
		hash = u.RecoveryHash
	}
	good, busy := verifySecretCtx(r.Context(), !known, hash, req.RecoveryAuth)
	if busy != nil {
		at.refund()
		failBusy(w)
		return
	}
	if !(good && err == nil && u.Status == "active") {
		fail(w, 401, "e-mail or recovery key is wrong")
		return
	}
	at.success()
	a.revokeTickets(u.ID) // one live ticket per user; also drops expired ones
	tok := randToken()
	a.tickets.Store(sha256hex(tok), ticket{u.ID, u.RecoveryHash, a.now().Add(ticketTTL)})
	writeJSON(w, 200, map[string]any{"ticket": tok, "wrapped_master_recovery": u.WrappedMasterRecovery})
}

type recoverFinishReq struct {
	Ticket              string    `json:"ticket"`
	NewAuth             string    `json:"new_auth"`
	NewKDF              kdfParams `json:"new_kdf"`
	NewWrappedMasterPW  string    `json:"new_wrapped_master_pw"`
	NewWrappedMasterRec string    `json:"new_wrapped_master_recovery"`
	NewRecoveryVerifier string    `json:"new_recovery_verifier"`
}

func (a *App) recoverFinish(w http.ResponseWriter, r *http.Request) {
	var req recoverFinishReq
	if !readJSON(w, r, &req) {
		return
	}
	// a malformed request is refused before the ticket is used up, so it does not cost the person their recovery
	if req.NewKDF.validate() != nil || checkLen(req.NewAuth, 32) != nil || checkLen(req.NewRecoveryVerifier, 32) != nil ||
		checkLen(req.NewWrappedMasterPW, wrappedLen) != nil || checkLen(req.NewWrappedMasterRec, wrappedLen) != nil {
		fail(w, 400, "invalid request")
		return
	}
	key := sha256hex(req.Ticket)
	v, ok := a.tickets.LoadAndDelete(key) // single use
	t, _ := v.(ticket)
	if !ok || a.now().After(t.expires) {
		fail(w, 403, "recovery session expired, start again")
		return
	}
	if u, err := a.userByID(t.userID); err != nil || u.Status != "active" {
		fail(w, 403, "recovery session expired, start again")
		return
	}
	ah, e1 := hashSecret(req.NewAuth)
	rh, e2 := hashSecret(req.NewRecoveryVerifier)
	if e1 != nil || e2 != nil {
		fail(w, 400, "invalid request")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE users SET kdf=?, auth_hash=?, wrapped_master_pw=?, wrapped_master_recovery=?, recovery_hash=? WHERE id=? AND recovery_hash=? AND status='active'`,
		req.NewKDF.json(), ah, req.NewWrappedMasterPW, req.NewWrappedMasterRec, rh, t.userID, t.recHash)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if rowsAffected(res, nil) != 1 { // the recovery key changed since the ticket was opened
		fail(w, 403, "recovery session expired, start again")
		return
	}
	if _, err := tx.Exec(`DELETE FROM sessions WHERE user_id=?`, t.userID); err != nil {
		fail(w, 500, "server error")
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, 500, "server error")
		return
	}
	a.revokeTickets(t.userID)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---- invites ----

func (a *App) validInvite(token string) (id, email string, err error) {
	var exp int64
	var used sql.NullInt64
	err = a.db.QueryRow(`SELECT id,email,expires_at,used_at FROM invites WHERE token_hash=?`, sha256hex(token)).Scan(&id, &email, &exp, &used)
	if err != nil || used.Valid || a.now().Unix() > exp {
		return "", "", errors.New("invalid invite")
	}
	return
}

func (a *App) inviteInfo(w http.ResponseWriter, r *http.Request) {
	_, email, err := a.validInvite(r.PathValue("token"))
	if err != nil {
		fail(w, 404, "this invite link is invalid or has expired")
		return
	}
	writeJSON(w, 200, map[string]string{"email": email})
}

func (a *App) inviteAccept(w http.ResponseWriter, r *http.Request) {
	var req keyBundle
	if !readJSON(w, r, &req) {
		return
	}
	ip := "invite|" + limiterIP(a.clientIP(r))
	if !a.loginIP.allowed(ip) {
		fail(w, 429, "too many attempts, try later")
		return
	}
	if req.validate() != nil {
		fail(w, 400, "invalid request")
		return
	}
	defQuota := a.defaultQuota() // before the transaction: a nested query would need a second pooled connection
	// Two accepts at once would each start a read transaction and then both try to write: SQLite refuses the second
	// upgrade, which used to surface as a bogus "invalid invite". Accepting one at a time is cheap for a family-sized server.
	a.acceptMu.Lock()
	defer a.acceptMu.Unlock()
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	tokHash := sha256hex(r.PathValue("token"))
	var id, email string
	var exp int64
	var used, invQuota sql.NullInt64
	if err := tx.QueryRow(`SELECT id,email,expires_at,used_at,quota_bytes FROM invites WHERE token_hash=?`, tokHash).Scan(&id, &email, &exp, &used, &invQuota); err != nil || used.Valid || a.now().Unix() > exp {
		a.loginIP.fail(ip)
		fail(w, 404, "this invite link is invalid or has expired")
		return
	}
	res, err := tx.Exec(`UPDATE invites SET used_at=? WHERE id=? AND used_at IS NULL`, a.now().Unix(), id)
	if rowsAffected(res, err) != 1 {
		fail(w, 404, "this invite link is invalid or has expired")
		return
	}
	uid, err := insertUser(r.Context(), tx, email, "user", inviteQuota(invQuota, defQuota), req, a.now())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			fail(w, 409, "an account with this e-mail already exists")
			return
		}
		fail(w, 500, "server error")
		return
	}
	if err := tx.Commit(); err != nil {
		fail(w, 500, "server error")
		return
	}
	ss, err := a.startSession(w, r, uid, "")
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	u, _ := a.userByID(uid)
	a.audit(email, "joined", email, "")
	writeJSON(w, 201, a.sessionBundle(u, ss))
}
