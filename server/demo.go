package main

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Public demo accounts (DEMO_ACCOUNTS): one login published for anyone to try the apps. Everything is end-to-end
// encrypted, so the operator could never see what strangers store; such an account may only read, plus keep the
// search index its own devices compute. Other accounts on the same server are not affected.

const demoRefused = "This is the public demo: changes are turned off."

// The writes a demo account may still make. Every other route that is not GET or HEAD is refused (demoAllows), so a
// route added later stays closed to it until it is listed here (TestDemoDefaultDeny walks every route).
var demoAllowed = map[string]bool{
	"POST /api/auth/logout":  true,
	"POST /api/items/thumbs": true, // a read: many thumbnails in one request
	// Nothing for search: visitors share the login, so anything one could store, the next would read. The demo's
	// index is built before the account is listed, and the apps only read it (demoIndexer).
}

// demoIndexWrite: the search writes a demo account's apps try on their own. They get the answer an app gets when
// another device indexes ("not_indexer"), which every app version handles by only reading from then on.
var demoIndexWrite = map[string]bool{
	"PUT /api/items/{id}/index": true,
	"PUT /api/me/indexer":       true,
}

// demoAccounts reads DEMO_ACCOUNTS: e-mail addresses, separated by commas or spaces, normalised like a sign-in.
func demoAccounts(v string) (map[string]bool, error) {
	out := map[string]bool{}
	for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
		e, ok := normEmail(f)
		if !ok {
			return nil, fmt.Errorf("DEMO_ACCOUNTS: %q is not an e-mail address", f)
		}
		out[e] = true
	}
	return out, nil
}

func (a *App) isDemo(u *user) bool { return a.demo[u.Email] }

// demoLoginSetting reads DEMO_LOGIN, "EMAIL PASSWORD": a demo login the sign-in page offers to everyone. Only for an
// account in DEMO_ACCOUNTS, so a typo can't publish a real account's password.
func demoLoginSetting(v string, demo map[string]bool) (map[string]string, error) {
	f := strings.Fields(v)
	if len(f) == 0 {
		return nil, nil
	}
	if len(f) != 2 {
		return nil, fmt.Errorf("DEMO_LOGIN: expected \"EMAIL PASSWORD\"")
	}
	e, ok := normEmail(f[0])
	if !ok || !demo[e] {
		return nil, fmt.Errorf("DEMO_LOGIN: %q is not in DEMO_ACCOUNTS", f[0])
	}
	return map[string]string{"email": e, "password": f[1]}, nil
}

// demoIndexer is the indexer the apps are told about for a demo account: never one of their devices, so they only
// read the index that was built before the account was listed.
const demoIndexer = "demo"

// demoAllows says whether a demo account may make this request; r.Pattern is the route it matched.
func demoAllows(r *http.Request) bool {
	return r.Method == http.MethodGet || r.Method == http.MethodHead || demoAllowed[r.Pattern]
}

// The demo's published login is shared by everyone, so what limits it is the visitor's address, not the account:
// requests per source (a token bucket: a steady rate with room for a gallery's first burst) and sign-ins per source
// (each costs an Argon2 check). Only demo accounts are limited this way; every other account on the same server, an
// app-store reviewer's included, is not.
const (
	demoRate      = 10  // requests per second per source, on average
	demoBurst     = 300 // and this many at once (a gallery's first screen and its thumbnails)
	demoSignIns   = 30  // sign-ins per source and hour
	demoSignInWin = time.Hour
)

type bucket struct {
	tokens float64
	at     time.Time
}

// demoBuckets is the per-source request budget of demo accounts.
type demoBuckets struct {
	mu    sync.Mutex
	m     map[string]*bucket
	now   func() time.Time
	swept time.Time
}

func newDemoBuckets() *demoBuckets { return &demoBuckets{m: map[string]*bucket{}, now: time.Now} }

// take spends one request of the source's budget; false when it is used up.
func (d *demoBuckets) take(src string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	t := d.now()
	if len(d.m) > 10000 && t.Sub(d.swept) > time.Minute {
		d.swept = t
		for k, b := range d.m {
			if t.Sub(b.at) > demoBurst*time.Second/demoRate {
				delete(d.m, k) // full again by now: the same as no entry
			}
		}
	}
	b := d.m[src]
	if b == nil {
		b = &bucket{tokens: demoBurst, at: t}
		d.m[src] = b
	}
	b.tokens += t.Sub(b.at).Seconds() * demoRate
	if b.tokens > demoBurst {
		b.tokens = demoBurst
	}
	b.at = t
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
