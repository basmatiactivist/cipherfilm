package main

import (
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// Passkeys (WebAuthn) as the second step of a sign-in, instead of a code from an authenticator app.
//
// Cipherfilm is end-to-end encrypted: the password derives the keys, so a passkey cannot replace it. It only stands in
// for the code after the password, with the same guarantees: the password step of an account with two-step sign-in
// returns only a pending token; the passkey challenge is bound to that token (one challenge at a time, used up by the
// first answer, right or wrong), counted in the same buckets as codes, and only a right answer starts a session.
//
// The relying party is the name the request reached the server by (its Host, which must be one of PUBLIC_HOSTS when
// that is set; never an address): a passkey is made for, and only accepted on, that name. Browsers send
// https://<name> as the origin; the Android app sends android:apk-key-hash:<its signing certificate's SHA-256>, from the
// certificates in ANDROID_APP_CERTS, which /.well-known/assetlinks.json also lists so Android lets the app use passkeys
// of the server's name.
//
// The server stores per passkey its credential id, the name it was made for, a name the person chose, when it was made
// and last used, and the credential record (public key, signature counter, transports, authenticator model),
// encrypted like the authenticator secrets under a key derived from the server's secret file, bound to the account
// and the credential id, so a copy or an edit of the database alone can't read, add or move one.

const (
	passkeyMax     = 20 // per account
	passkeyNameMax = 64 // characters
	waTTL          = 5 * time.Minute

	// the release key of the official app (docs/RELEASING.md); Google Play signs with the same key
	defaultAndroidCerts    = "87:D9:E9:AB:85:5B:03:E7:D7:D3:15:2F:5A:76:A4:D8:AF:B5:D3:8E:FC:A3:B9:93:2A:D9:3F:1B:A1:7C:67:12"
	defaultAndroidPackages = "app.cipherfilm"
)

var errNoRelyingParty = errors.New("passkeys need the server's https name")

// androidApps are the app packages and signing certificates that may use passkeys of this server (ANDROID_APP_PACKAGES,
// ANDROID_APP_CERTS: SHA-256 fingerprints as keytool shows them, with or without colons; "none" for no app).
type androidApps struct {
	packages []string
	certs    [][]byte
}

func androidSetting(packages, certs string) (androidApps, error) {
	if packages == "" {
		packages = defaultAndroidPackages
	}
	if certs == "" {
		certs = defaultAndroidCerts
	}
	var out androidApps
	if strings.EqualFold(strings.TrimSpace(certs), "none") {
		return out, nil
	}
	split := func(v string) []string {
		return strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' })
	}
	for _, p := range split(packages) {
		out.packages = append(out.packages, p)
	}
	for _, c := range split(certs) {
		b, err := hex.DecodeString(strings.ReplaceAll(c, ":", ""))
		if err != nil || len(b) != 32 {
			return androidApps{}, fmt.Errorf("ANDROID_APP_CERTS: %q is not a SHA-256 fingerprint", c)
		}
		out.certs = append(out.certs, b)
	}
	return out, nil
}

// origins are what the Android app sends as its origin: android:apk-key-hash: and the certificate's hash, base64url.
func (x androidApps) origins() []string {
	var out []string
	for _, c := range x.certs {
		out = append(out, "android:apk-key-hash:"+base64.RawURLEncoding.EncodeToString(c))
	}
	return out
}

// assetLinks answers /.well-known/assetlinks.json: the apps that may use this server's passkeys (Android checks it
// before it lets an app use a passkey of a web name). Nothing in it is secret.
func (a *App) assetLinks(w http.ResponseWriter, r *http.Request) {
	if len(a.android.certs) == 0 {
		http.NotFound(w, r)
		return
	}
	var fps []string
	for _, c := range a.android.certs {
		h := strings.ToUpper(hex.EncodeToString(c))
		var parts []string
		for i := 0; i < len(h); i += 2 {
			parts = append(parts, h[i:i+2])
		}
		fps = append(fps, strings.Join(parts, ":"))
	}
	var out []map[string]any
	for _, p := range a.android.packages {
		out = append(out, map[string]any{
			"relation": []string{"delegate_permission/common.get_login_creds"},
			"target":   map[string]any{"namespace": "android_app", "package_name": p, "sha256_cert_fingerprints": fps},
		})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	json.NewEncoder(w).Encode(out)
}

// rpName is the relying party id for a request: the name it reached the server by, without port; never an address,
// and only one of PUBLIC_HOSTS when that is set (hostGuard refuses the others before they get here).
func (a *App) rpName(r *http.Request) (name, origin string, err error) {
	host := strings.ToLower(r.Host)
	name = host
	port := ""
	if h, p, e := net.SplitHostPort(host); e == nil {
		name, port = h, p
	}
	if name == "" || net.ParseIP(strings.Trim(name, "[]")) != nil || strings.ContainsAny(name, "/\\@?#") {
		return "", "", errNoRelyingParty
	}
	if len(a.hosts) > 0 && !a.hosts[name] {
		return "", "", errNoRelyingParty
	}
	if protocol.ValidateRPID(name) != nil {
		return "", "", errNoRelyingParty
	}
	origin = "https://" + name
	if port != "" && port != "443" {
		origin += ":" + port
	}
	return name, origin, nil
}

// relyingParty is the WebAuthn configuration for the name the request reached the server by.
func (a *App) relyingParty(r *http.Request) (*webauthn.WebAuthn, error) {
	name, origin, err := a.rpName(r)
	if err != nil {
		return nil, err
	}
	origins := []string{origin}
	// browsers allow WebAuthn on plain http only for localhost (local development)
	if name == "localhost" || strings.HasSuffix(name, ".localhost") {
		origins = append(origins, "http"+strings.TrimPrefix(origin, "https"))
	}
	return webauthn.New(&webauthn.Config{
		RPID:                  name,
		RPDisplayName:         "Cipherfilm",
		RPOrigins:             origins,
		RPOpaqueOrigins:       a.android.origins(),
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementPreferred,
			UserVerification: protocol.VerificationPreferred,
		},
		// passkey providers report extension results nobody asked for (credProps from browsers and Android's
		// Credential Manager); they are the client's own words, not signed, and nothing here uses any of them
		ExtensionsUnsolicitedOutputPolicy: protocol.UnsolicitedOutputPolicyIgnore,
	})
}

// ---- stored passkeys ----

type passkey struct {
	ID, UserID, CredID, RPID, Name string
	Created, LastUsed              int64
	sealed                         string
	cred                           webauthn.Credential
}

func (a *App) passkeyAEAD() cipher.AEAD {
	block, err := aes.NewCipher(hmacSum(a.secret, "cipherfilm passkey at rest v1"))
	if err != nil {
		panic(err)
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return g
}

func (a *App) sealPasskey(userID, credID string, c *webauthn.Credential) (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	g := a.passkeyAEAD()
	nonce := randBytes(g.NonceSize())
	return "1." + b64.EncodeToString(append(nonce, g.Seal(nil, nonce, b, []byte("passkey|"+userID+"|"+credID))...)), nil
}

func (a *App) openPasskey(userID, credID, stored string) (webauthn.Credential, error) {
	var c webauthn.Credential
	v, ok := strings.CutPrefix(stored, "1.")
	if !ok {
		return c, errors.New("unknown format")
	}
	b, err := b64.DecodeString(v)
	g := a.passkeyAEAD()
	if err != nil || len(b) < g.NonceSize()+g.Overhead() {
		return c, errors.New("bad record")
	}
	plain, err := g.Open(nil, b[:g.NonceSize()], b[g.NonceSize():], []byte("passkey|"+userID+"|"+credID))
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(plain, &c)
	return c, err
}

// passkeysOf lists an account's passkeys; with rpID, only those made for that name (and readable).
func (a *App) passkeysOf(userID, rpID string) ([]passkey, error) {
	rows, err := a.db.Query(`SELECT id,cred_id,rp_id,cred,name,created_at,last_used_at FROM passkeys WHERE user_id=? AND (?='' OR rp_id=?) ORDER BY created_at, id`, userID, rpID, rpID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []passkey
	for rows.Next() {
		p := passkey{UserID: userID}
		if err := rows.Scan(&p.ID, &p.CredID, &p.RPID, &p.sealed, &p.Name, &p.Created, &p.LastUsed); err != nil {
			return nil, err
		}
		if rpID != "" {
			if p.cred, err = a.openPasskey(userID, p.CredID, p.sealed); err != nil {
				continue // not this server's (a database from elsewhere) or changed: never accepted
			}
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// waUser is an account as the WebAuthn library sees it. The user handle is the account's random id, nothing personal.
type waUser struct {
	u     *user
	creds []webauthn.Credential
}

func (w waUser) WebAuthnID() []byte                         { return []byte(w.u.ID) }
func (w waUser) WebAuthnName() string                       { return w.u.Email }
func (w waUser) WebAuthnDisplayName() string                { return w.u.Email }
func (w waUser) WebAuthnCredentials() []webauthn.Credential { return w.creds }

func credsOf(l []passkey) []webauthn.Credential {
	out := make([]webauthn.Credential, len(l))
	for i, p := range l {
		out[i] = p.cred
	}
	return out
}

// ---- challenges ----

// waChallenge is one WebAuthn ceremony waiting for its answer: what the library needs to check it, the name it was
// begun on, and for whom.
type waChallenge struct {
	sd       webauthn.SessionData
	rpID     string
	userID   string
	authHash string // the password it was begun under (registration)
	// twoFactorAtBegin: two-step sign-in was on when the registration began, so a second step was checked for it
	twoFactorAtBegin bool
	expires          time.Time
}

// challengeStore keeps one open ceremony per signed-in session (keyed by the session's hash); taking it uses it up.
type challengeStore struct {
	mu sync.Mutex
	m  map[string]*waChallenge
}

func newChallengeStore() *challengeStore { return &challengeStore{m: map[string]*waChallenge{}} }

func (c *challengeStore) put(key string, ch *waChallenge, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, x := range c.m {
		if now.After(x.expires) {
			delete(c.m, k)
		}
	}
	c.m[key] = ch
}

func (c *challengeStore) take(key string, now time.Time) *waChallenge {
	c.mu.Lock()
	defer c.mu.Unlock()
	x := c.m[key]
	delete(c.m, key)
	if x == nil || now.After(x.expires) {
		return nil
	}
	return x
}

func (c *challengeStore) dropUser(userID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, x := range c.m {
		if x.userID == userID {
			delete(c.m, k)
		}
	}
}

// beginAssertion makes a challenge for the account's passkeys of this name; nil options when it has none here.
func (a *App) beginAssertion(r *http.Request, u *user) (*protocol.PublicKeyCredentialRequestOptions, *waChallenge, error) {
	rp, err := a.relyingParty(r)
	if err != nil {
		return nil, nil, err
	}
	l, err := a.passkeysOf(u.ID, rp.Config.RPID)
	if err != nil {
		return nil, nil, err
	}
	if len(l) == 0 {
		return nil, nil, nil
	}
	opts, sd, err := rp.BeginLogin(waUser{u, credsOf(l)})
	if err != nil {
		return nil, nil, err
	}
	return &opts.Response, &waChallenge{sd: *sd, rpID: rp.Config.RPID, userID: u.ID, expires: a.now().Add(waTTL)}, nil
}

// usePasskey checks a passkey's answer to a challenge of this account and records the use. The challenge must have
// been begun on the name this request reached the server by; a signature counter that doesn't move forward (a copied
// authenticator) is refused, and the new counter is stored only if the record is still the one that was checked, so
// two requests with the same answer can't both pass.
func (a *App) usePasskey(r *http.Request, u *user, ch *waChallenge, raw json.RawMessage) bool {
	if ch == nil || ch.userID != u.ID || a.now().After(ch.expires) || len(raw) == 0 {
		return false
	}
	rp, err := a.relyingParty(r)
	if err != nil || rp.Config.RPID != ch.rpID {
		return false
	}
	l, err := a.passkeysOf(u.ID, ch.rpID)
	if err != nil || len(l) == 0 {
		return false
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(raw)
	if err != nil {
		return false
	}
	cred, err := rp.ValidateLogin(waUser{u, credsOf(l)}, ch.sd, parsed)
	if err != nil || cred.Authenticator.CloneWarning {
		return false
	}
	i := slices.IndexFunc(l, func(p passkey) bool { return string(p.cred.ID) == string(cred.ID) })
	if i < 0 {
		return false
	}
	sealed, err := a.sealPasskey(u.ID, l[i].CredID, cred)
	if err != nil {
		return false
	}
	res, err := a.db.Exec(`UPDATE passkeys SET cred=?, last_used_at=? WHERE id=? AND user_id=? AND cred=?`, sealed, a.now().Unix(), l[i].ID, u.ID, l[i].sealed)
	return rowsAffected(res, err) == 1
}

// hasPasskeysHere says whether the account has a passkey for the name this request reached the server by.
func (a *App) hasPasskeysHere(r *http.Request, u *user) bool {
	if u.Passkeys == 0 {
		return false
	}
	name, _, err := a.rpName(r)
	if err != nil {
		return false
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM passkeys WHERE user_id=? AND rp_id=?`, u.ID, name).Scan(&n)
	return n > 0
}

// ---- routes ----

func (a *App) passkeyRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/auth/login/2fa/passkey", a.loginPasskeyBegin)
	m.HandleFunc("POST /api/me/2fa/passkey", a.auth(false, a.proofPasskeyBegin))
	m.HandleFunc("GET /api/me/passkeys", a.auth(false, a.passkeyList))
	m.HandleFunc("POST /api/me/passkeys/register/begin", a.auth(false, a.passkeyRegisterBegin))
	m.HandleFunc("POST /api/me/passkeys/register/finish", a.auth(false, a.passkeyRegisterFinish))
	m.HandleFunc("PATCH /api/me/passkeys/{id}", a.auth(false, a.passkeyRename))
	m.HandleFunc("DELETE /api/me/passkeys/{id}", a.auth(false, a.passkeyDelete))
}

func failNoRP(w http.ResponseWriter) {
	writeJSON(w, http.StatusConflict, map[string]string{"error": "passkeys work only when the server is reached by its https name", "code": "passkeys_unavailable"})
}

type pendingReq struct {
	Pending string `json:"pending"`
}

// loginPasskeyBegin gives a pending sign-in (the password was right) a challenge for the account's passkeys. A new one
// replaces the previous; the answer is sent to POST /api/auth/login/2fa as "passkey".
func (a *App) loginPasskeyBegin(w http.ResponseWriter, r *http.Request) {
	var req pendingReq
	if !readJSON(w, r, &req) {
		return
	}
	h := sha256hex(req.Pending)
	p, ok := a.pending.peek(h, a.now())
	if !ok {
		writeJSON(w, 401, map[string]string{"error": pendingGone, "code": "two_factor_expired"})
		return
	}
	u, err := a.userByID(p.userID)
	if err != nil || u.Status != "active" || !ctEqual(u.AuthHash, p.authHash) {
		a.pending.drop(h, a.now())
		writeJSON(w, 401, map[string]string{"error": pendingGone, "code": "two_factor_expired"})
		return
	}
	opts, ch, err := a.beginAssertion(r, u)
	if errors.Is(err, errNoRelyingParty) {
		failNoRP(w)
		return
	}
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if opts == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this account has no passkey for this address", "code": "no_passkey"})
		return
	}
	if !a.pending.setChallenge(h, ch, a.now()) {
		writeJSON(w, 401, map[string]string{"error": pendingGone, "code": "two_factor_expired"})
		return
	}
	writeJSON(w, 200, map[string]any{"options": opts})
}

// proofPasskeyBegin gives a signed-in session a challenge, to answer with a passkey instead of a code where a change
// to two-step sign-in asks for one (proofReq.Passkey).
func (a *App) proofPasskeyBegin(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if a.isDemo(u) {
		fail(w, 403, demoRefused)
		return
	}
	opts, ch, err := a.beginAssertion(r, u)
	if errors.Is(err, errNoRelyingParty) {
		failNoRP(w)
		return
	}
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if opts == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this account has no passkey for this address", "code": "no_passkey"})
		return
	}
	a.waProof.put(s.IDHash, ch, a.now())
	writeJSON(w, 200, map[string]any{"options": opts})
}

type passkeyView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	RPID     string `json:"rp_id"`
	Here     bool   `json:"here"` // made for the name this request reached the server by
	Created  int64  `json:"created_at"`
	LastUsed int64  `json:"last_used_at"`
}

func (a *App) passkeyList(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	l, err := a.passkeysOf(u.ID, "")
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	name, _, rpErr := a.rpName(r)
	out := []passkeyView{}
	for _, p := range l {
		out = append(out, passkeyView{p.ID, p.Name, p.RPID, p.RPID == name, p.Created, p.LastUsed})
	}
	writeJSON(w, 200, map[string]any{"passkeys": out, "available": rpErr == nil && !a.isDemo(u), "max": passkeyMax})
}

// passkeyRegisterBegin starts adding a passkey: it needs the password and, while two-step sign-in is on, a code or
// another passkey too, so a session alone, or one with the password, can't add a second step of its own.
func (a *App) passkeyRegisterBegin(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if a.isDemo(u) {
		fail(w, 403, demoRefused)
		return
	}
	var req proofReq
	if !readJSON(w, r, &req) || !a.checkPassword(w, r, u, "passkey-add", req.CurrentAuth) {
		return
	}
	if u.twoFactor() && !a.secondFactor(w, r, u, s, req) {
		return
	}
	rp, err := a.relyingParty(r)
	if err != nil {
		failNoRP(w)
		return
	}
	all, err := a.passkeysOf(u.ID, "")
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if len(all) >= passkeyMax {
		fail(w, http.StatusConflict, fmt.Sprintf("an account can have at most %d passkeys", passkeyMax))
		return
	}
	var exclude []protocol.CredentialDescriptor
	for _, p := range all {
		if id, err := base64.RawURLEncoding.DecodeString(p.CredID); err == nil && p.RPID == rp.Config.RPID {
			exclude = append(exclude, protocol.CredentialDescriptor{Type: protocol.PublicKeyCredentialType, CredentialID: id})
		}
	}
	opts, sd, err := rp.BeginRegistration(waUser{u, nil}, webauthn.WithExclusions(exclude))
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	a.waReg.put(s.IDHash, &waChallenge{sd: *sd, rpID: rp.Config.RPID, userID: u.ID, authHash: u.AuthHash, twoFactorAtBegin: u.twoFactor(), expires: a.now().Add(waTTL)}, a.now())
	writeJSON(w, 200, map[string]any{"options": opts.Response})
}

type registerReq struct {
	Name       string          `json:"name"`
	Credential json.RawMessage `json:"credential"`
}

func passkeyName(s string) (string, bool) {
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		s = "Passkey"
	}
	return s, utf8.RuneCountInString(s) <= passkeyNameMax && utf8.ValidString(s)
}

// passkeyRegisterFinish stores the new passkey. If it is the account's first second step, two-step sign-in is on from
// now on and the recovery codes are made and shown, once, as when an authenticator app is set up.
func (a *App) passkeyRegisterFinish(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if a.isDemo(u) {
		fail(w, 403, demoRefused)
		return
	}
	var req registerReq
	if !readJSON(w, r, &req) {
		return
	}
	name, ok := passkeyName(req.Name)
	if !ok {
		fail(w, 400, "that name is too long")
		return
	}
	ch := a.waReg.take(s.IDHash, a.now())
	if ch == nil || ch.userID != u.ID || !ctEqual(ch.authHash, u.AuthHash) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "start adding the passkey again", "code": "passkey_expired"})
		return
	}
	rp, err := a.relyingParty(r)
	if err != nil || rp.Config.RPID != ch.rpID {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "start adding the passkey again", "code": "passkey_expired"})
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "this passkey couldn't be added", "code": "passkey_refused"})
		return
	}
	cred, err := rp.CreateCredential(waUser{u, nil}, ch.sd, parsed)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "this passkey couldn't be added", "code": "passkey_refused"})
		return
	}
	credID := base64.RawURLEncoding.EncodeToString(cred.ID)
	sealed, err := a.sealPasskey(u.ID, credID, cred)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	var wasOn, count int
	if err := tx.QueryRow(`SELECT totp_secret<>'', (SELECT COUNT(*) FROM passkeys WHERE user_id=users.id) FROM users WHERE id=? AND auth_hash=? AND status='active'`,
		u.ID, u.AuthHash).Scan(&wasOn, &count); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "start adding the passkey again", "code": "passkey_expired"})
		return
	}
	// begun while two-step sign-in was off (no second step checked), and it is on now: this would add a second step
	// without one
	if !ch.twoFactorAtBegin && (wasOn != 0 || count > 0) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "start adding the passkey again", "code": "passkey_expired"})
		return
	}
	if count >= passkeyMax {
		fail(w, http.StatusConflict, fmt.Sprintf("an account can have at most %d passkeys", passkeyMax))
		return
	}
	id := randID()
	now := a.now().Unix()
	if _, err := tx.Exec(`INSERT INTO passkeys(id,user_id,cred_id,rp_id,cred,name,created_at,last_used_at) VALUES (?,?,?,?,?,?,?,0)`,
		id, u.ID, credID, ch.rpID, sealed, name, now); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			fail(w, http.StatusConflict, "this passkey is already added")
			return
		}
		fail(w, 500, "server error")
		return
	}
	// an authenticator setup still open is dropped: it was begun under other conditions (see twoFactorEnable)
	if _, err := tx.Exec(`UPDATE users SET totp_pending='' WHERE id=?`, u.ID); err != nil {
		fail(w, 500, "server error")
		return
	}
	var codes []string
	first := wasOn == 0 && count == 0
	if first {
		codes = newRecoveryCodes()
		if a.replaceCodes(tx, u.ID, codes) != nil {
			fail(w, 500, "server error")
			return
		}
	}
	if tx.Commit() != nil {
		fail(w, 500, "server error")
		return
	}
	if first {
		a.audit(u.Email, "turned on two-step sign-in", u.Email, "passkey")
	} else {
		a.audit(u.Email, "added a passkey", u.Email, "")
	}
	a.factorNotice(u, s, r, noticePasskeyAdded)
	out := map[string]any{"passkey": passkeyView{id, name, ch.rpID, true, now, 0}}
	if first {
		out["recovery_codes"] = codes
	}
	writeJSON(w, 200, out)
}

type renameReq struct {
	Name string `json:"name"`
}

func (a *App) passkeyRename(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if a.isDemo(u) {
		fail(w, 403, demoRefused)
		return
	}
	var req renameReq
	if !readJSON(w, r, &req) {
		return
	}
	name, ok := passkeyName(req.Name)
	if !ok {
		fail(w, 400, "that name is too long")
		return
	}
	res, err := a.db.Exec(`UPDATE passkeys SET name=? WHERE id=? AND user_id=?`, name, r.PathValue("id"), u.ID)
	if rowsAffected(res, err) != 1 {
		fail(w, 404, "not found")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// passkeyDelete removes a passkey; it needs the password and a second step (a code, a recovery code or a passkey,
// this one too). Without the last passkey and without an authenticator app, two-step sign-in is off and the recovery
// codes go.
func (a *App) passkeyDelete(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if a.isDemo(u) {
		fail(w, 403, demoRefused)
		return
	}
	var req proofReq
	if !readJSON(w, r, &req) || !a.checkPassword(w, r, u, "passkey-remove", req.CurrentAuth) {
		return
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM passkeys WHERE id=? AND user_id=?`, r.PathValue("id"), u.ID).Scan(&n)
	if n != 1 {
		fail(w, 404, "not found")
		return
	}
	if !a.secondFactor(w, r, u, s, req) {
		return
	}
	off, err := a.removePasskey(r, u.ID, r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "not found")
		return
	}
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	if off {
		a.audit(u.Email, "turned off two-step sign-in", u.Email, "passkey")
		a.factorNotice(u, s, r, noticeTwoFactorOff)
	} else {
		a.audit(u.Email, "removed a passkey", u.Email, "")
		a.factorNotice(u, s, r, noticePasskeyRemoved)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "two_factor": !off})
}

// removePasskey deletes one passkey; off is true when it was the account's last second step.
func (a *App) removePasskey(r *http.Request, userID, id string) (off bool, err error) {
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`DELETE FROM passkeys WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return false, err
	}
	if rowsAffected(res, nil) != 1 {
		return false, sql.ErrNoRows
	}
	var on int
	if err := tx.QueryRow(`SELECT (totp_secret<>'') + (SELECT COUNT(*) FROM passkeys WHERE user_id=users.id) FROM users WHERE id=?`, userID).Scan(&on); err != nil {
		return false, err
	}
	if on == 0 {
		if _, err := tx.Exec(`DELETE FROM recovery_codes WHERE user_id=?`, userID); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	if on == 0 {
		// two-step sign-in is off now: pending sign-ins and the session challenges begun under it go
		a.pending.dropUser(userID, a.now())
		a.waProof.dropUser(userID)
		a.waReg.dropUser(userID)
	}
	return on == 0, nil
}
