package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"
)

const deviceCookie = "__Host-dev"

// A device cookie marks a browser that has signed in to an account before. A request carrying a valid one is
// counted in a separate per-account bucket instead of the per-source ones, so strangers who share the same source
// address (every client behind one proxy, e.g. Tailscale Serve) cannot lock the real user out. The cookie is an HMAC
// over the user id and the current password hash, so changing the password invalidates it. It grants nothing
// except a different rate-limit bucket: the password is still required.
func (a *App) deviceMAC(userID, authHash string) string {
	m := hmac.New(sha256.New, a.secret)
	m.Write([]byte("device|" + userID + "|" + authHash))
	return hex.EncodeToString(m.Sum(nil))
}

func (a *App) knownDevice(r *http.Request, u *user) bool {
	// a demo account's password is public: every visitor would get the same cookie and share one bucket
	if a.isDemo(u) {
		return false
	}
	c, err := r.Cookie(deviceCookie)
	if err != nil {
		return false
	}
	id, mac, ok := strings.Cut(c.Value, ".")
	if !ok || id != u.ID {
		return false
	}
	return hmac.Equal([]byte(mac), []byte(a.deviceMAC(u.ID, u.AuthHash)))
}

func (a *App) setDevice(w http.ResponseWriter, u *user) {
	if a.isDemo(u) {
		return
	}
	http.SetCookie(w, &http.Cookie{Name: deviceCookie, Value: u.ID + "." + a.deviceMAC(u.ID, u.AuthHash), Path: "/",
		MaxAge: 180 * 24 * 3600, HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
}

// knownInFlight is how many credential checks from known browsers one account may have running or waiting at once.
// The known lane is not turned away when the server is busy, so without this one account (anyone who has its
// password and signed in once) could queue checks without end and keep every other sign-in waiting.
const knownInFlight = 2

// Password proofs of signed-in sessions (proofOK), per account, right or wrong: plenty for a person, few for a flood.
const (
	proofsPerAccount = 30
	proofWindow      = 15 * time.Minute
)

type inFlight struct {
	mu sync.Mutex
	m  map[string]int
}

// take admits one more check for key, false when it has max running or waiting already. release must be called when
// the check is done.
func (f *inFlight) take(key string, max int) (release func(), ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.m == nil {
		f.m = map[string]int{}
	}
	if f.m[key] >= max {
		return nil, false
	}
	f.m[key]++
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.m[key]--; f.m[key] <= 0 {
			delete(f.m, key)
		}
	}, true
}

// knownTurn admits one credential check from a known browser of the account; false when it has knownInFlight
// already. release must be called when the check is done.
func (a *App) knownTurn(userID string) (release func(), ok bool) {
	return a.knownBusy.take(userID, knownInFlight)
}

// sourceInFlight is how many sign-in and recovery checks from unknown browsers one source may have running or waiting
// at once, well below maxArgonWaiting: a right password or recovery key gives back its place in the per-source bucket,
// so without this someone who knows their own (or any one) account's credentials could keep the queue full from one
// address, and everyone else's sign-ins from new browsers would be turned away.
const sourceInFlight = 4

// sourceTurn admits one credential check from an unknown browser of the source (limiterIP of the client).
func (a *App) sourceTurn(source string) (release func(), ok bool) {
	return a.sourceBusy.take(source, sourceInFlight)
}
