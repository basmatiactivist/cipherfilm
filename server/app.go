package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	cookieName = "__Host-sid"
	// A session lasts while it is used: it ends after 30 days without a request (the cookie and expires_at move
	// forward with use), and at the latest a year after sign-in. Devices are listed and can be signed out one by one
	// (sessions.go), so a lost one doesn't need short sessions everywhere; before 1.9.0 every device had to sign in
	// again every 14 days and after a day without use. sessionIdle is the longest a device may go unused; the person
	// can choose a shorter time for their account (sessions.go idleLimit), and a device unused for longer is signed out
	// as if from another device, so it deletes what it keeps.
	sessionAbs  = 365 * 24 * time.Hour
	sessionIdle = 30 * 24 * time.Hour
	sessionsMax = 50 // live sessions per account; a new sign-in beyond it ends another (startSession)
	inviteTTL   = 7 * 24 * time.Hour
	ticketTTL   = 10 * time.Minute

	// a session younger than this is the first to go when the account has too many: see startSession
	sessionSettle = 24 * time.Hour
)

type App struct {
	db         *sql.DB
	dataDir    string
	secret     []byte // HMAC key for fake KDF params; persisted in data dir
	trustProxy bool
	tsHeaders  bool              // TRUST_TAILSCALE_HEADERS: key per-source limits by Tailscale Serve's user header
	proxies    []netip.Prefix    // TRUSTED_PROXIES: the peers whose X-Forwarded-For counts; empty: loopback and private
	hosts      map[string]bool   // PUBLIC_HOSTS; empty: any
	ports      hostPorts         // ports other than 443 PUBLIC_HOSTS publishes its names on (name:port)
	mapConf    *mapConfig        // MAP_STYLE; nil: no map (mapconf.go)
	demo       map[string]bool   // DEMO_ACCOUNTS: read-only public logins (demo.go)
	demoLogin  map[string]string // DEMO_LOGIN: the one the sign-in page offers (email, password), or nil
	dummyHash  string
	loginIP    *limiter
	loginAcct  *limiter         // per (account, source)
	loginDev   *limiter         // per account, for browsers carrying a valid device cookie
	knownBusy  inFlight         // credential checks of known browsers per account (device.go)
	sourceBusy inFlight         // credential checks of unknown browsers per source (device.go)
	proofBusy  inFlight         // password proofs of signed-in sessions per session (proofOK)
	proofs     *limiter         // password proofs of signed-in sessions per session, right or wrong (proofOK)
	demoReqs   *demoBuckets     // requests of demo accounts, per source (demo.go)
	demoSignIn *limiter         // sign-ins to demo accounts, per source (demo.go)
	tickets    sync.Map         // recovery tickets: token hash -> ticket
	pending    *pendingStore    // sign-ins waiting for their second step (twofactor.go)
	totpAcct   *limiter         // second-step codes per account, short window (twofactor.go)
	totpDay    *limiter         // second-step codes per account, per day
	android    androidApps      // the apps that may use this server's passkeys (passkeys.go)
	waProof    *challengeStore  // passkey challenges of signed-in sessions, answered instead of a code
	waReg      *challengeStore  // passkeys being added, per session
	resMu      sync.Mutex       // guards reserved
	auxMu      sync.Mutex       // pairs a thumbnail or preview count with its file
	reserved   map[string]int64 // in-flight upload bytes per user
	listMu     sync.Mutex
	lists      map[string]chan struct{} // per user: the list pages being built and sent (see listing)
	acceptMu   sync.Mutex               // one invite acceptance at a time (see inviteAccept)
	adminMu    sync.Mutex               // serialises admin changes to accounts (see adminGuard)
	live       *hub                     // the open live-update streams (events.go)
	now        func() time.Time
}

type ctxKey int

const (
	userKey ctxKey = iota
	sessKey
)

type user struct {
	ID, Email, Role, Status                string
	KDF, AuthHash, Pubkey                  string
	WrappedMasterPW, WrappedMasterRecovery string
	WrappedPrivkey, RecoveryHash           string
	CreatedAt                              int64
	NSFW                                   bool   // the admin allows search of explicit content
	Indexer                                string // the session (pub id) that computes the search index, or ""
	TOTPSecret, TOTPPending                string // encrypted (twofactor.go); "" = none
	TOTPLast                               int64  // the last time step a code was accepted for
	Passkeys                               int    // how many passkeys it has (passkeys.go)
	IdleDays                               int    // a device unused this many days is signed out (sessions.go)
}

// twoFactor: the account signs in with a code from an authenticator app, or a passkey, after the password.
func (u *user) twoFactor() bool { return u.TOTPSecret != "" || u.Passkeys > 0 }

// Pub names a session in the device list (the cookie's hash stays on the server).
type session struct {
	IDHash, UserID, CSRF, Pub string
	Created                   int64 // when this device signed in
	renewed                   bool  // its expiry moved forward: the cookie is sent again with the new lifetime
}

func newApp(dataDir string) (*App, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	db, err := openDB(filepath.Join(dataDir, "app.db"))
	if err != nil {
		return nil, err
	}
	secret, err := loadSecret(filepath.Join(dataDir, "secret"))
	if err != nil {
		return nil, err
	}
	proxies, err := trustedProxies(os.Getenv("TRUSTED_PROXIES"))
	if err != nil {
		return nil, err
	}
	demo, err := demoAccounts(os.Getenv("DEMO_ACCOUNTS"))
	if err != nil {
		return nil, err
	}
	mapConf, err := mapSetting(os.Getenv("MAP_STYLE"))
	if err != nil {
		return nil, err
	}
	demoLogin, err := demoLoginSetting(os.Getenv("DEMO_LOGIN"), demo)
	if err != nil {
		return nil, err
	}
	android, err := androidSetting(os.Getenv("ANDROID_APP_PACKAGES"), os.Getenv("ANDROID_APP_CERTS"))
	if err != nil {
		return nil, err
	}
	dummy, _ := hashSecret(b64.EncodeToString(randBytes(32)))
	a := &App{
		db: db, dataDir: dataDir, secret: secret, dummyHash: dummy,
		trustProxy: os.Getenv("TRUST_PROXY") == "1",
		tsHeaders:  os.Getenv("TRUST_TAILSCALE_HEADERS") == "1",
		proxies:    proxies,
		hosts:      publicHosts(os.Getenv("PUBLIC_HOSTS")),
		ports:      publicPorts(os.Getenv("PUBLIC_HOSTS")),
		demo:       demo,
		demoLogin:  demoLogin,
		mapConf:    mapConf,
		loginIP:    newLimiter(15*time.Minute, 30),
		loginAcct:  newLimiter(15*time.Minute, 10),
		loginDev:   newLimiter(15*time.Minute, 20),
		proofs:     newLimiter(proofWindow, proofsPerSession),
		demoReqs:   newDemoBuckets(),
		demoSignIn: newLimiter(demoSignInWin, demoSignIns),
		pending:    newPendingStore(),
		totpAcct:   newLimiter(totpAcctWin, totpAcctMax),
		totpDay:    newLimiter(24*time.Hour, totpDayMax),
		android:    android,
		waProof:    newChallengeStore(),
		waReg:      newChallengeStore(),
		now:        time.Now,
		reserved:   map[string]int64{},
		lists:      map[string]chan struct{}{},
		live:       newHub(time.Now()),
	}
	// Without PUBLIC_HOSTS a page on any name that resolves to the app (DNS rebinding) is served as its own origin,
	// and could pick its own X-Forwarded-For; the header is then not trusted at all.
	if len(a.hosts) == 0 {
		a.trustProxy = false
	}
	return a, nil
}

// trustedProxies reads TRUSTED_PROXIES: addresses or CIDR ranges, separated by commas or spaces.
func trustedProxies(v string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
		p, err := netip.ParsePrefix(f)
		if err != nil {
			addr, err2 := netip.ParseAddr(f)
			if err2 != nil {
				return nil, fmt.Errorf("TRUSTED_PROXIES: %q is not an address or range", f)
			}
			p = netip.PrefixFrom(addr.Unmap(), addr.Unmap().BitLen())
		}
		out = append(out, p.Masked())
	}
	return out, nil
}

// fromProxy says whether the peer is the trusted proxy: one of TRUSTED_PROXIES, or by default a loopback or private
// address (a proxy on the same host or Docker network), never a peer from the internet.
func (a *App) fromProxy(remoteAddr string) bool {
	h, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		h = remoteAddr
	}
	addr, err := netip.ParseAddr(h)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	if len(a.proxies) == 0 {
		return addr.IsLoopback() || addr.IsPrivate()
	}
	for _, p := range a.proxies {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// loadSecret reads the HMAC secret, or makes one when there is none. A file that exists but cannot be read, or isn't
// 32 bytes long, is an error, not a reason to replace it: a new secret signs out every known browser, changes the fake
// salts and makes every authenticator secret, recovery code and passkey of the accounts unusable.
func loadSecret(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil && len(b) == 32 {
		return b, nil
	}
	if err == nil {
		return nil, fmt.Errorf("%s is %d bytes long, not 32: restore it from a backup (a new one would make every account's two-step sign-in unusable)", path, len(b))
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	b = randBytes(32)
	return b, os.WriteFile(path, b, 0o600)
}

// initSetup prints a one-time setup token while no user exists.
func (a *App) initSetup() error {
	var n int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		_, err := a.db.Exec(`DELETE FROM setup_state`)
		return err
	}
	tok := randToken()
	if _, err := a.db.Exec(`INSERT INTO setup_state(id, token_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash`, sha256hex(tok)); err != nil {
		return err
	}
	log.Printf("FIRST-TIME SETUP: open the app and use this one-time setup token: %s", tok)
	return nil
}

func (a *App) clientIP(r *http.Request) string {
	if a.trustProxy && a.fromProxy(r.RemoteAddr) {
		// Exactly one trusted proxy is assumed. It appends the address it saw, so the LAST entry is the one it
		// vouches for; earlier entries are whatever the client sent and can be forged.
		// a proxy may add its own header line instead of extending the client's: the last line, last entry is the proxy's
		if vals := r.Header.Values("X-Forwarded-For"); len(vals) > 0 {
			parts := strings.Split(vals[len(vals)-1], ",")
			// only an address counts: anything else would let the sender invent new limiter keys
			if last, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
				return last.String()
			}
		}
	}
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	if id := a.tailscaleUser(r, h); id != "" {
		return id
	}
	return h
}

// tailscaleUser is the source key for a request that Tailscale Serve forwarded on behalf of a tailnet user: behind
// Serve every client is 127.0.0.1, so per-source limits would be one bucket for the whole server. Serve sets
// Tailscale-User-Login to the user it identified and removes the header from what the client sent; it sets none for
// tagged devices (they keep sharing 127.0.0.1). Only with TRUST_TAILSCALE_HEADERS=1, TRUST_PROXY off and a loopback
// peer: anything else that can reach the app on loopback (a proxy that passes client headers through, such as Caddy
// in the domain overlay) could otherwise choose its own key. "" when it does not apply.
func (a *App) tailscaleUser(r *http.Request, peer string) string {
	if !a.tsHeaders || a.trustProxy {
		return ""
	}
	if addr, err := netip.ParseAddr(peer); err != nil || !addr.Unmap().IsLoopback() {
		return ""
	}
	v := r.Header.Values("Tailscale-User-Login")
	if len(v) != 1 || v[0] == "" || len(v[0]) > 256 || clean(v[0]) != v[0] {
		return ""
	}
	return "tailscale:" + strings.ToLower(v[0])
}

// limiterIP is the key used for rate limiting: IPv6 addresses are grouped by /64, since one subscriber
// normally controls a whole /64 and could otherwise mint unlimited "different" sources.
func limiterIP(ip string) string {
	if a, err := netip.ParseAddr(ip); err == nil {
		a = a.Unmap() // ::ffff:1.2.3.4 and 1.2.3.4 are one client
		if !a.Is6() {
			return a.String()
		}
		if p, err := a.Prefix(64); err == nil {
			return p.String()
		}
	}
	return ip
}

// ---- middleware ----

// sameOrigin rejects cross-site state-changing requests (defence in depth next to SameSite=Strict).
func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if sfs := r.Header.Get("Sec-Fetch-Site"); sfs != "" && sfs != "same-origin" && sfs != "none" {
				fail(w, http.StatusForbidden, "cross-site request blocked")
				return
			}
			if o := r.Header.Get("Origin"); o != "" {
				u, err := url.Parse(o)
				if err != nil || u.Host != r.Host {
					fail(w, http.StatusForbidden, "cross-origin request blocked")
					return
				}
			}
			if ct := r.Header.Get("Content-Type"); r.ContentLength != 0 && !strings.HasPrefix(ct, "application/json") && ct != "application/octet-stream" {
				fail(w, http.StatusUnsupportedMediaType, "JSON required")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) auth(admin bool, next func(http.ResponseWriter, *http.Request, *user, *session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil {
			fail(w, http.StatusUnauthorized, "not signed in")
			return
		}
		// a phone's periodic background check (the Android app's notice check, mobile/src/noticeCheck.ts) is not the
		// person using the device: it neither keeps the session from ending when idle nor shows the device as active
		quiet := r.Method == http.MethodGet && r.Header.Get("X-CF-Background") == "1"
		u, s, err := a.lookupSession(c.Value, !quiet)
		if err != nil {
			if a.revoked(c.Value) {
				w.Header().Set("X-CF-Session", "revoked")
			}
			fail(w, http.StatusUnauthorized, "not signed in")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !ctEqual(r.Header.Get("X-CSRF-Token"), s.CSRF) {
				fail(w, http.StatusForbidden, "invalid CSRF token")
				return
			}
		}
		if s.renewed {
			setSessionCookie(w, c.Value, s.Created+int64(sessionAbs.Seconds())-a.now().Unix())
		}
		if a.isDemo(u) && !a.demoReqs.take(limiterIP(a.clientIP(r))) {
			w.Header().Set("Retry-After", "10")
			fail(w, http.StatusTooManyRequests, "too many requests, try again in a few seconds")
			return
		}
		if a.isDemo(u) && !demoAllows(r) {
			if demoIndexWrite[r.Pattern] {
				// as when another device indexes: every app version then only reads the index built beforehand
				writeJSON(w, 409, map[string]string{"error": "another device indexes your photos", "code": "not_indexer"})
				return
			}
			fail(w, http.StatusForbidden, demoRefused)
			return
		}
		// a published login never administers the server, even if it is listed by mistake
		if admin && (u.Role != "admin" || a.isDemo(u)) {
			fail(w, http.StatusNotFound, "not found")
			return
		}
		next(w, r, u, s)
	}
}

// lookupSession finds the session of a cookie; touch counts the request as activity (last_seen, the idle timeout).
func (a *App) lookupSession(token string, touch bool) (*user, *session, error) {
	h := sha256hex(token)
	now := a.now().Unix()
	var s session
	var last, exp int64
	var created int64
	var idleDays int
	err := a.db.QueryRow(`SELECT id_hash,user_id,csrf,pub,created_at,last_seen,expires_at,
		COALESCE((SELECT device_idle_days FROM users WHERE id=sessions.user_id),0) FROM sessions WHERE id_hash=?`, h).
		Scan(&s.IDHash, &s.UserID, &s.CSRF, &s.Pub, &created, &last, &exp, &idleDays)
	if err != nil {
		return nil, nil, err
	}
	s.Created = created
	// unused for longer than the account allows (sessions.go idleLimit): signed out as if from another device, so the
	// device deletes what it keeps when it comes back (an unused device may be a lost one)
	if now-last > idleLimit(idleDays) {
		a.remember(`id_hash=?`, h)
		a.db.Exec(`DELETE FROM sessions WHERE id_hash=?`, h)
		a.dropInvitesOf(s.UserID, `created_session=?`, s.Pub)
		return nil, nil, errors.New("expired")
	}
	if now > exp {
		a.deleteSessions(`id_hash=?`, h)
		return nil, nil, errors.New("expired")
	}
	u, err := a.userByID(s.UserID)
	if err != nil || u.Status != "active" {
		return nil, nil, errors.New("inactive")
	}
	// at most once a minute: a write (and its fsync) for every thumbnail made browsing slow
	if touch && now-last >= 60 {
		next := min(now+int64(sessionIdle.Seconds()), created+int64(sessionAbs.Seconds()))
		a.db.Exec(`UPDATE sessions SET last_seen=?, expires_at=? WHERE id_hash=?`, now, next, h)
		s.renewed = next > exp
	}
	return u, &s, nil
}

func (a *App) userBy(where string, arg any) (*user, error) {
	var u user
	err := a.db.QueryRow(`SELECT id,email,role,status,kdf,auth_hash,pubkey,wrapped_master_pw,wrapped_master_recovery,wrapped_privkey,recovery_hash,created_at,nsfw,indexer,totp_secret,totp_pending,totp_last,
		(SELECT COUNT(*) FROM passkeys p WHERE p.user_id=users.id),device_idle_days FROM users WHERE `+where, arg).
		Scan(&u.ID, &u.Email, &u.Role, &u.Status, &u.KDF, &u.AuthHash, &u.Pubkey, &u.WrappedMasterPW, &u.WrappedMasterRecovery, &u.WrappedPrivkey, &u.RecoveryHash, &u.CreatedAt, &u.NSFW, &u.Indexer, &u.TOTPSecret, &u.TOTPPending, &u.TOTPLast, &u.Passkeys, &u.IdleDays)
	if err != nil {
		return nil, err
	}
	return &u, nil
}
func (a *App) userByID(id string) (*user, error)   { return a.userBy("id=?", id) }
func (a *App) userByEmail(e string) (*user, error) { return a.userBy("email=?", e) }

// errCredentialsChanged: the password changed between checking it and starting the session.
var errCredentialsChanged = errors.New("credentials changed")

func (a *App) startSession(w http.ResponseWriter, r *http.Request, userID, authHash string) (s *session, err error) {
	tok, csrf, pub := randToken(), randToken(), randID()[:24]
	now := a.now()
	// ended sessions go; one that ended because its device went unused (not at the year's end) as signed out on
	// purpose, as lookupSession does when such a device comes back first
	a.remember(`expires_at < ? AND expires_at < created_at + ?`, now.Unix(), int64(sessionAbs.Seconds()))
	if _, err = a.deleteSessions(`expires_at < ?`, now.Unix()); err != nil {
		return
	}
	// with authHash, the session is only created if the password that was just checked is still the account's: a
	// password change or recovery that ran during the check has already ended every session and must end this one too
	res, err := a.db.Exec(`INSERT INTO sessions(id_hash,user_id,csrf,created_at,last_seen,expires_at,pub,device) SELECT ?,?,?,?,?,?,?,?
		WHERE ? = '' OR EXISTS (SELECT 1 FROM users WHERE id=? AND auth_hash=? AND status='active')`,
		sha256hex(tok), userID, csrf, now.Unix(), now.Unix(), now.Add(sessionIdle).Unix(), pub, deviceName(r), authHash, userID, authHash)
	if err != nil {
		return
	}
	if rowsAffected(res, nil) != 1 {
		return nil, errCredentialsChanged
	}
	// at most sessionsMax per account (each is a row, and a device-list entry, for up to a year), never this new one.
	// Which go first: those unused for longer than the account allows (signed out on purpose, as when they come back),
	// then the ones that signed in within sessionSettle, then the one idle longest. So a burst of sign-ins (someone with
	// the password) pushes out its own sessions, not the devices that are shown the notices about it. A device pushed
	// out otherwise is asked to sign in again; nothing is wiped.
	var idle int
	a.db.QueryRow(`SELECT device_idle_days FROM users WHERE id=?`, userID).Scan(&idle)
	limit := idleLimit(idle)
	over := `user_id=? AND id_hash NOT IN (SELECT id_hash FROM sessions WHERE user_id=?
		ORDER BY id_hash=? DESC, ?-last_seen > ? ASC, created_at > ? ASC, last_seen DESC, created_at DESC LIMIT ?)`
	args := []any{userID, userID, sha256hex(tok), now.Unix(), limit, now.Add(-sessionSettle).Unix(), sessionsMax}
	a.remember(over+` AND ?-last_seen > ?`, append(args, now.Unix(), limit)...)
	if n, _ := a.deleteSessions(over, args...); n > 0 {
		a.live.recheck(userID)
	}
	// the browser's previous session, if it had one, is replaced by this one: end it rather than leave it valid
	if c, err := r.Cookie(cookieName); err == nil {
		a.deleteSessions(`id_hash=?`, sha256hex(c.Value))
	}
	setSessionCookie(w, tok, int64(sessionAbs.Seconds()))
	a.db.Exec(`UPDATE users SET last_login_at=? WHERE id=?`, now.Unix(), userID)
	if u, uerr := a.userByID(userID); uerr == nil {
		a.setDevice(w, u)
	}
	return &session{IDHash: sha256hex(tok), UserID: userID, CSRF: csrf, Pub: pub, Created: now.Unix()}, nil
}

// deleteSessions ends the sessions where selects (a fixed condition, values in args) and the open invites made from
// them: an invite does not outlive the session that made it, however that session ends.
func (a *App) deleteSessions(where string, args ...any) (int64, error) {
	type ended struct{ user, pub string }
	var gone []ended
	if rows, err := a.db.Query(`SELECT user_id,pub FROM sessions WHERE `+where, args...); err == nil {
		for rows.Next() {
			var x ended
			if rows.Scan(&x.user, &x.pub) == nil {
				gone = append(gone, x)
			}
		}
		rows.Close()
	}
	res, err := a.db.Exec(`DELETE FROM sessions WHERE `+where, args...)
	if err != nil {
		return 0, err
	}
	for _, x := range gone {
		a.dropInvitesOf(x.user, `created_session=?`, x.pub)
	}
	return res.RowsAffected()
}

// setSessionCookie sends the session's cookie, kept by the browser for the session's whole remaining lifetime (maxAge
// seconds, up to the year's end), not only for the time it may go unused: a device that comes back after it was signed
// out (also because it went unused) must still present it, or it can't be told it was signed out on purpose and only
// asks to sign in again, keeping its copy. The server ends an unused session itself.
func setSessionCookie(w http.ResponseWriter, tok string, maxAge int64) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: tok, Path: "/", MaxAge: int(max(maxAge, 1)),
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
}

func clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
}

// insertUser stores a new account. Caller supplies tx so setup/invite checks are atomic.
func insertUser(ctx context.Context, tx *sql.Tx, email, role string, userQuota int64, b keyBundle, now time.Time) (string, error) {
	ah, err := hashSecret(b.Auth)
	if err != nil {
		return "", err
	}
	rh, err := hashSecret(b.RecoveryVerifier)
	if err != nil {
		return "", err
	}
	id := randID()
	var quota int64 // 0 = unlimited (the admin); invited users get a default quota
	if role == "user" {
		quota = userQuota
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO users(id,email,role,kdf,auth_hash,pubkey,wrapped_master_pw,wrapped_master_recovery,wrapped_privkey,recovery_hash,quota_bytes,created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, email, role, b.KDF.json(), ah, b.Pubkey, b.WrappedMasterPW, b.WrappedMasterRecovery, b.WrappedPrivkey, rh, quota, now.Unix())
	return id, err
}

var _ = sha256.Size

// revokeTickets invalidates every outstanding recovery ticket of a user (after a credential change) and drops expired ones.
func (a *App) revokeTickets(userID string) {
	now := a.now()
	a.tickets.Range(func(k, v any) bool {
		if t, ok := v.(ticket); ok && (t.userID == userID || now.After(t.expires)) {
			a.tickets.Delete(k)
		}
		return true
	})
}

// hostGuard answers only for the names in PUBLIC_HOSTS (when set): a page on some other name that resolves to this
// server (DNS rebinding) is not treated as this app's own origin. /healthz stays open for the container's check.
func (a *App) hostGuard(next http.Handler) http.Handler {
	if len(a.hosts) == 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if !a.hosts[strings.ToLower(host)] && r.URL.Path != "/healthz" {
			fail(w, http.StatusMisdirectedRequest, "unknown host")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// publicHosts reads PUBLIC_HOSTS: names separated by commas or spaces, each optionally with the port the app is
// published on when that isn't 443 (name:port; see publicPorts).
func publicHosts(v string) map[string]bool {
	out := map[string]bool{}
	for _, h := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
		if name, _, err := net.SplitHostPort(h); err == nil {
			h = name
		}
		out[strings.ToLower(h)] = true
	}
	return out
}

// hostPorts: per name, the ports it is published on besides 443.
type hostPorts map[string]map[string]bool

// publicPorts reads the ports PUBLIC_HOSTS gives with its names (name:port): the https origins besides
// https://name that passkeys of that name are accepted from (passkeys.go rpName).
func publicPorts(v string) hostPorts {
	out := hostPorts{}
	for _, h := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
		if name, port, err := net.SplitHostPort(h); err == nil && port != "" && port != "443" {
			name = strings.ToLower(name)
			if out[name] == nil {
				out[name] = map[string]bool{}
			}
			out[name][port] = true
		}
	}
	return out
}
