package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Two-step sign-in: after the password, a 6-digit code from an authenticator app (TOTP, RFC 6238: HMAC-SHA-1,
// 30-second steps, the step before and after accepted too), or one of ten one-time recovery codes.
//
// The password step of a sign-in to such an account returns no session, no cookie and none of the account's key
// material, only a pending token: random, stored hashed in memory, valid for 5 minutes, good for 5 wrong codes and
// one right one, bound to the account and to the password hash it was issued for (a password change or recovery
// meanwhile ends it). Codes are counted per source and per account (also across sources: the code space is small, so
// someone who has the password must not be able to spread guesses over many addresses), and a code is never accepted
// twice (totp_last). Unlocking an already signed-in device needs no code: it never asks the server.
//
// The server has to know the secret to check a code. It keeps it encrypted under a key derived from its own secret
// file (data/secret), so a copy of the database alone doesn't reveal it; whoever has both, or runs the server, can
// make codes. Recovery codes are stored only as keyed hashes (HMAC under the same secret).

const (
	totpPeriod   = 30
	totpDigits   = 6
	totpSkew     = 1 // steps before and after the current one
	totpAcctWin  = 15 * time.Minute
	totpAcctMax  = 5  // codes per account in totpAcctWin
	totpDayMax   = 20 // codes per account per day
	pendingTTL   = 5 * time.Minute
	pendingTries = 5 // wrong codes per pending sign-in; then the password is needed again
	pendingMax   = 10000
	pendingPer   = 3 // open pending sign-ins per account; a newer one replaces the oldest
	recoveryN    = 10

	twoFactorRequired = "two_factor_required"
	// shown by app versions that don't know the second step: they read the error and stop
	twoFactorMsg = "this account uses two-step sign-in: enter the code from your authenticator app (update the app if it doesn't ask for one)"
)

var (
	b32Secret = base32.StdEncoding.WithPadding(base32.NoPadding)
	// recovery codes: Crockford's alphabet (no i, l, o, u), so a code read aloud or written down survives
	rcAlphabet = "0123456789abcdefghjkmnpqrstvwxyz"
	b32Code    = base32.NewEncoding(rcAlphabet).WithPadding(base32.NoPadding)
)

// ---- TOTP ----

func hotp(secret []byte, counter uint64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	m := hmac.New(sha1.New, secret)
	m.Write(msg[:])
	h := m.Sum(nil)
	off := h[len(h)-1] & 0x0f
	v := binary.BigEndian.Uint32(h[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", v%1000000)
}

func digitsOnly(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// totpMatch says which time step in the window the code belongs to. Every step is computed and compared in constant
// time, whichever matches.
func totpMatch(secret []byte, code string, now time.Time) (int64, bool) {
	if !digitsOnly(code, totpDigits) {
		return 0, false
	}
	cur := now.Unix() / totpPeriod
	found, ok := int64(0), 0
	for d := int64(-totpSkew); d <= totpSkew; d++ {
		m := subtle.ConstantTimeCompare([]byte(hotp(secret, uint64(cur+d))), []byte(code))
		found = int64(subtle.ConstantTimeSelect(m, int(cur+d), int(found)))
		ok |= m
	}
	return found, ok == 1
}

func otpauthURI(email, secret string) string {
	q := url.Values{"secret": {secret}, "issuer": {"Cipherfilm"}, "algorithm": {"SHA1"}, "digits": {"6"}, "period": {"30"}}
	return "otpauth://totp/" + url.PathEscape("Cipherfilm:"+email) + "?" + q.Encode()
}

// ---- secrets at rest ----

func (a *App) totpAEAD() cipher.AEAD {
	block, err := aes.NewCipher(hmacSum(a.secret, "cipherfilm totp secret at rest v1"))
	if err != nil {
		panic(err)
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return g
}

// sealTOTP encrypts an authenticator secret for the users row; slot ("on" or "pending") and the user id are bound in,
// so a value cannot be moved to another account or from pending to on without the code check.
func (a *App) sealTOTP(userID, slot string, secret []byte) string {
	g := a.totpAEAD()
	nonce := randBytes(g.NonceSize())
	ct := g.Seal(nil, nonce, secret, []byte("totp|"+slot+"|"+userID))
	return "1." + b64.EncodeToString(append(nonce, ct...))
}

func (a *App) openTOTP(userID, slot, stored string) ([]byte, error) {
	v, ok := strings.CutPrefix(stored, "1.")
	if !ok {
		return nil, errors.New("unknown format")
	}
	b, err := b64.DecodeString(v)
	g := a.totpAEAD()
	if err != nil || len(b) < g.NonceSize()+g.Overhead() {
		return nil, errors.New("bad secret")
	}
	return g.Open(nil, b[:g.NonceSize()], b[g.NonceSize():], []byte("totp|"+slot+"|"+userID))
}

// ---- recovery codes ----

func newRecoveryCodes() []string {
	out := make([]string, recoveryN)
	for i := range out {
		c := b32Code.EncodeToString(randBytes(10)) // 80 bits, 16 characters
		out[i] = c[0:4] + "-" + c[4:8] + "-" + c[8:12] + "-" + c[12:16]
	}
	return out
}

// normRecoveryCode accepts a code as typed: any case, with or without dashes and spaces, and the letters people
// mistake for digits.
func normRecoveryCode(s string) (string, bool) {
	s = strings.NewReplacer("-", "", " ", "", "o", "0", "i", "1", "l", "1").Replace(strings.ToLower(s))
	if len(s) != 16 {
		return "", false
	}
	for _, c := range s {
		if !strings.ContainsRune(rcAlphabet, c) {
			return "", false
		}
	}
	return s, true
}

func (a *App) recoveryHash(userID, code string) string {
	return hex.EncodeToString(hmacSum(hmacSum(a.secret, "cipherfilm recovery codes v1"), userID+"|"+code))
}

// replaceCodes stores new recovery codes in place of the account's old ones, inside the caller's transaction.
func (a *App) replaceCodes(tx *sql.Tx, userID string, codes []string) error {
	if _, err := tx.Exec(`DELETE FROM recovery_codes WHERE user_id=?`, userID); err != nil {
		return err
	}
	for _, c := range codes {
		n, _ := normRecoveryCode(c)
		if _, err := tx.Exec(`INSERT INTO recovery_codes(user_id,code_hash) VALUES (?,?)`, userID, a.recoveryHash(userID, n)); err != nil {
			return err
		}
	}
	return nil
}

// ---- checking a code ----

// useCode checks a second-step code and uses it up: a TOTP code moves totp_last forward (so it, and every older one,
// is refused from then on), a recovery code is deleted. Both happen atomically in the database, so two requests with
// the same code cannot both pass.
func (a *App) useCode(u *user, code string) bool {
	c := strings.NewReplacer(" ", "", "-", "").Replace(strings.TrimSpace(code))
	if digitsOnly(c, totpDigits) {
		secret, err := a.openTOTP(u.ID, "on", u.TOTPSecret)
		if err != nil {
			return false
		}
		step, ok := totpMatch(secret, c, a.now())
		clear(secret)
		if !ok || step <= u.TOTPLast {
			return false
		}
		res, err := a.db.Exec(`UPDATE users SET totp_last=? WHERE id=? AND totp_last<? AND totp_secret=?`, step, u.ID, step, u.TOTPSecret)
		return rowsAffected(res, err) == 1
	}
	n, ok := normRecoveryCode(c)
	if !ok {
		return false
	}
	// only a code of the current enrolment: turning two-step sign-in off deletes them, but a request already on its
	// way must not use one after it was turned on again
	res, err := a.db.Exec(`DELETE FROM recovery_codes WHERE user_id=? AND code_hash=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND totp_secret=? AND totp_secret<>'')`,
		u.ID, a.recoveryHash(u.ID, n), u.ID, u.TOTPSecret)
	return rowsAffected(res, err) == 1
}

// codeSlots are the buckets every second-step code is counted in, wherever it is entered.
func (a *App) codeSlots(userID string) []slot {
	return []slot{{a.totpAcct, "2fa|" + userID, true}, {a.totpDay, "2fa|" + userID, true}}
}

// forgetCodeTries: after a password change or recovery whoever was guessing codes no longer has the password, so the
// real person isn't kept waiting by their failures.
func (a *App) forgetCodeTries(userID string) {
	a.totpAcct.clear("2fa|" + userID)
	a.totpDay.clear("2fa|" + userID)
	a.pending.dropUser(userID)
}

// ---- pending sign-ins ----

type pendingSignIn struct {
	userID, authHash string
	created, expires time.Time
	tries            int
	busy             bool // a code for it is being checked
}

type pendingStore struct {
	mu sync.Mutex
	m  map[string]*pendingSignIn // token hash ->
}

func newPendingStore() *pendingStore { return &pendingStore{m: map[string]*pendingSignIn{}} }

func (p *pendingStore) sweep(now time.Time) {
	for k, x := range p.m {
		if now.After(x.expires) {
			delete(p.m, k)
		}
	}
}

// add stores a pending sign-in; false when the server holds too many already.
func (p *pendingStore) add(tokHash string, x *pendingSignIn, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sweep(now)
	if len(p.m) >= pendingMax {
		return false
	}
	var mine []string
	for k, o := range p.m {
		if o.userID == x.userID {
			mine = append(mine, k)
		}
	}
	for len(mine) >= pendingPer {
		old := 0
		for i, k := range mine {
			if p.m[k].created.Before(p.m[mine[old]].created) {
				old = i
			}
		}
		delete(p.m, mine[old])
		mine = append(mine[:old], mine[old+1:]...)
	}
	p.m[tokHash] = x
	return true
}

var errPendingBusy = errors.New("being checked")

// claim takes a pending sign-in for one code check. Until done() is called no other request can use it.
func (p *pendingStore) claim(tokHash string, now time.Time) (pendingSignIn, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	x := p.m[tokHash]
	if x == nil || now.After(x.expires) {
		delete(p.m, tokHash)
		return pendingSignIn{}, errors.New("no such sign-in")
	}
	if x.busy {
		return pendingSignIn{}, errPendingBusy
	}
	x.busy = true
	return *x, nil
}

// done ends a check: used is true when the code was right (the pending sign-in is gone, single use), counted when
// a wrong code counts against it, false when it was turned away unchecked (rate limit).
func (p *pendingStore) done(tokHash string, used, counted bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	x := p.m[tokHash]
	if x == nil {
		return
	}
	x.busy = false
	if counted {
		x.tries++
	}
	if used || x.tries >= pendingTries {
		delete(p.m, tokHash)
	}
}

func (p *pendingStore) drop(tokHash string) {
	p.mu.Lock()
	delete(p.m, tokHash)
	p.mu.Unlock()
}

func (p *pendingStore) dropUser(userID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, x := range p.m {
		if x.userID == userID {
			delete(p.m, k)
		}
	}
}

func (p *pendingStore) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.m)
}

// startPending answers the password step of a sign-in to an account with two-step sign-in: a pending token, nothing else.
func (a *App) startPending(w http.ResponseWriter, u *user) {
	tok := randToken()
	now := a.now()
	if !a.pending.add(sha256hex(tok), &pendingSignIn{userID: u.ID, authHash: u.AuthHash, created: now, expires: now.Add(pendingTTL)}, now) {
		failBusy(w)
		return
	}
	writeJSON(w, http.StatusUnauthorized, map[string]any{"error": twoFactorMsg, "code": twoFactorRequired, "pending": tok,
		"expires_in": int(pendingTTL.Seconds())})
}

// ---- routes ----

func (a *App) twoFactorRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/auth/login/2fa", a.login2fa)
	m.HandleFunc("GET /api/me/2fa", a.auth(false, a.twoFactorStatus))
	m.HandleFunc("POST /api/me/2fa/setup", a.auth(false, a.twoFactorSetup))
	m.HandleFunc("POST /api/me/2fa/enable", a.auth(false, a.twoFactorEnable))
	m.HandleFunc("POST /api/me/2fa/disable", a.auth(false, a.twoFactorDisable))
	m.HandleFunc("POST /api/me/2fa/recovery-codes", a.auth(false, a.twoFactorNewCodes))
	m.HandleFunc("DELETE /api/admin/users/{id}/2fa", a.auth(true, a.adminResetTwoFactor))
}

type login2faReq struct {
	Pending string `json:"pending"`
	Code    string `json:"code"`
}

const pendingGone = "this sign-in expired; sign in again with your password"

// login2fa is the second step of a sign-in: the pending token from the password step and a code.
func (a *App) login2fa(w http.ResponseWriter, r *http.Request) {
	var req login2faReq
	if !readJSON(w, r, &req) {
		return
	}
	h := sha256hex(req.Pending)
	p, err := a.pending.claim(h, a.now())
	if errors.Is(err, errPendingBusy) {
		fail(w, http.StatusConflict, "this code is being checked; wait a moment")
		return
	}
	if err != nil {
		writeJSON(w, 401, map[string]string{"error": pendingGone, "code": "two_factor_expired"})
		return
	}
	ip := limiterIP(a.clientIP(r))
	at, ok := reserve(append([]slot{{a.loginIP, "2fa|" + ip, false}}, a.codeSlots(p.userID)...)...)
	if !ok {
		a.pending.done(h, false, false)
		fail(w, 429, "too many attempts, try later")
		return
	}
	u, err := a.userByID(p.userID)
	// the password it was issued for must still be the account's, and the account active with two-step sign-in on
	if err != nil || u.Status != "active" || !ctEqual(u.AuthHash, p.authHash) || !u.twoFactor() {
		a.pending.drop(h)
		at.refund()
		writeJSON(w, 401, map[string]string{"error": pendingGone, "code": "two_factor_expired"})
		return
	}
	if !a.useCode(u, req.Code) {
		a.pending.done(h, false, true)
		writeJSON(w, 401, map[string]string{"error": "that code isn't right", "code": "wrong_code"})
		return
	}
	a.pending.done(h, true, false) // single use
	at.success()
	ss, err := a.startSession(w, r, u.ID, u.AuthHash)
	if errors.Is(err, errCredentialsChanged) {
		writeJSON(w, 401, map[string]string{"error": pendingGone, "code": "two_factor_expired"})
		return
	}
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	a.noticeSignIn(u, ss, r)
	writeJSON(w, 200, a.sessionBundle(u, ss))
}

func (a *App) recoveryCodesLeft(userID string) int {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM recovery_codes WHERE user_id=?`, userID).Scan(&n)
	return n
}

func (a *App) twoFactorStatus(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	out := map[string]any{"enabled": u.twoFactor(), "recovery_codes_left": 0, "available": !a.isDemo(u)}
	if u.twoFactor() {
		out["recovery_codes_left"] = a.recoveryCodesLeft(u.ID)
	}
	writeJSON(w, 200, out)
}

type proofReq struct {
	CurrentAuth string `json:"current_auth"`
}

// checkPassword verifies the password proof sent with a change to two-step sign-in, counted like a password change.
func (a *App) checkPassword(w http.ResponseWriter, u *user, what, proof string) bool {
	at, ok := reserve(slot{a.loginAcct, what + "|" + u.ID, true})
	if !ok {
		fail(w, 429, "too many attempts, try later")
		return false
	}
	if !verifySecret(u.AuthHash, proof) {
		fail(w, 403, "that password isn't right")
		return false
	}
	at.success()
	return true
}

// twoFactorSetup makes a new authenticator secret and shows it once; it is on only after a code from it was confirmed.
func (a *App) twoFactorSetup(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if a.isDemo(u) {
		fail(w, 403, demoRefused)
		return
	}
	var req proofReq
	if !readJSON(w, r, &req) || !a.checkPassword(w, u, "2fa-setup", req.CurrentAuth) {
		return
	}
	if u.twoFactor() {
		fail(w, http.StatusConflict, "two-step sign-in is already on")
		return
	}
	secret := randBytes(20) // 160 bits, as RFC 4226 recommends
	defer clear(secret)
	res, err := a.db.Exec(`UPDATE users SET totp_pending=? WHERE id=? AND totp_secret='' AND auth_hash=? AND status='active'`,
		a.sealTOTP(u.ID, "pending", secret), u.ID, u.AuthHash)
	if rowsAffected(res, err) != 1 {
		fail(w, http.StatusConflict, "your account changed meanwhile; try again")
		return
	}
	key := b32Secret.EncodeToString(secret)
	writeJSON(w, 200, map[string]any{"secret": key, "uri": otpauthURI(u.Email, key), "algorithm": "SHA1", "digits": totpDigits, "period": totpPeriod})
}

type codeReq struct {
	Code string `json:"code"`
}

// twoFactorEnable turns two-step sign-in on once a code from the new secret is right, and returns the recovery codes:
// the only time they are shown.
func (a *App) twoFactorEnable(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if a.isDemo(u) {
		fail(w, 403, demoRefused)
		return
	}
	var req codeReq
	if !readJSON(w, r, &req) {
		return
	}
	if u.twoFactor() {
		fail(w, http.StatusConflict, "two-step sign-in is already on")
		return
	}
	if u.TOTPPending == "" {
		fail(w, http.StatusConflict, "start the setup again")
		return
	}
	at, ok := reserve(a.codeSlots(u.ID)...)
	if !ok {
		fail(w, 429, "too many attempts, try later")
		return
	}
	secret, err := a.openTOTP(u.ID, "pending", u.TOTPPending)
	if err != nil {
		fail(w, http.StatusConflict, "start the setup again")
		return
	}
	defer clear(secret)
	step, good := totpMatch(secret, strings.TrimSpace(req.Code), a.now())
	if !good {
		writeJSON(w, 403, map[string]string{"error": "that code isn't right", "code": "wrong_code"})
		return
	}
	codes := newRecoveryCodes()
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE users SET totp_secret=?, totp_pending='', totp_last=? WHERE id=? AND totp_pending=? AND totp_secret='' AND status='active'`,
		a.sealTOTP(u.ID, "on", secret), step, u.ID, u.TOTPPending)
	if rowsAffected(res, err) != 1 {
		fail(w, http.StatusConflict, "start the setup again")
		return
	}
	if a.replaceCodes(tx, u.ID, codes) != nil || tx.Commit() != nil {
		fail(w, 500, "server error")
		return
	}
	at.success()
	a.audit(u.Email, "turned on two-step sign-in", u.Email, "")
	writeJSON(w, 200, map[string]any{"recovery_codes": codes})
}

type proofCodeReq struct {
	CurrentAuth string `json:"current_auth"`
	Code        string `json:"code"`
}

// proofAndCode checks what turning two-step sign-in off or making new recovery codes needs: the password proof and a
// current code (or a recovery code, which is used up).
func (a *App) proofAndCode(w http.ResponseWriter, r *http.Request, u *user, what string) bool {
	var req proofCodeReq
	if !readJSON(w, r, &req) || !a.checkPassword(w, u, what, req.CurrentAuth) {
		return false
	}
	if !u.twoFactor() {
		fail(w, http.StatusConflict, "two-step sign-in is off")
		return false
	}
	at, ok := reserve(a.codeSlots(u.ID)...)
	if !ok {
		fail(w, 429, "too many attempts, try later")
		return false
	}
	if !a.useCode(u, req.Code) {
		writeJSON(w, 403, map[string]string{"error": "that code isn't right", "code": "wrong_code"})
		return false
	}
	at.success()
	return true
}

// twoFactorDisable turns two-step sign-in off; the recovery codes go with it.
func (a *App) twoFactorDisable(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if !a.proofAndCode(w, r, u, "2fa-off") {
		return
	}
	if !a.turnOff(r.Context(), u.ID, u.TOTPSecret) {
		fail(w, http.StatusConflict, "two-step sign-in changed meanwhile; try again")
		return
	}
	a.audit(u.Email, "turned off two-step sign-in", u.Email, "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// turnOff removes the account's authenticator secret and recovery codes; with secret, only if it is still that one.
func (a *App) turnOff(ctx context.Context, userID, secret string) bool {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return false
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE users SET totp_secret='', totp_pending='', totp_last=0 WHERE id=? AND totp_secret<>'' AND (?='' OR totp_secret=?)`, userID, secret, secret)
	if rowsAffected(res, err) != 1 {
		return false
	}
	if _, err := tx.Exec(`DELETE FROM recovery_codes WHERE user_id=?`, userID); err != nil {
		return false
	}
	if tx.Commit() != nil {
		return false
	}
	a.pending.dropUser(userID)
	return true
}

// twoFactorNewCodes replaces the recovery codes (the old ones stop working) and shows the new ones once.
func (a *App) twoFactorNewCodes(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if !a.proofAndCode(w, r, u, "2fa-codes") {
		return
	}
	codes := newRecoveryCodes()
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	var n int
	// only while two-step sign-in is still on with the same secret
	if tx.QueryRow(`SELECT COUNT(*) FROM users WHERE id=? AND totp_secret=? AND totp_secret<>''`, u.ID, u.TOTPSecret).Scan(&n) != nil || n != 1 {
		fail(w, http.StatusConflict, "two-step sign-in changed meanwhile; try again")
		return
	}
	if a.replaceCodes(tx, u.ID, codes) != nil || tx.Commit() != nil {
		fail(w, 500, "server error")
		return
	}
	writeJSON(w, 200, map[string]any{"recovery_codes": codes})
}

// adminResetTwoFactor turns two-step sign-in off for someone who lost their authenticator and recovery codes. They
// sign in with the password alone and can turn it on again; their devices show a notice that it happened.
func (a *App) adminResetTwoFactor(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	id := r.PathValue("id")
	if id == u.ID {
		fail(w, 400, "turn off your own two-step sign-in under Account")
		return
	}
	a.adminMu.Lock()
	defer a.adminMu.Unlock()
	target, err := a.userByID(id)
	if err != nil {
		fail(w, 404, "not found")
		return
	}
	if !a.adminGuard(w, u, target, false) {
		return
	}
	if !a.turnOff(r.Context(), id, "") {
		fail(w, http.StatusConflict, "two-step sign-in is already off")
		return
	}
	a.notify(id, noticeTwoFactorReset, "", "")
	a.audit(u.Email, "two-step sign-in turned off", target.Email, "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}
