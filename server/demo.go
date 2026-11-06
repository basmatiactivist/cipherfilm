package main

import (
	"fmt"
	"net/http"
	"strings"
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

// demoIndexer is the indexer the apps are told about for a demo account: never one of their devices, so they only
// read the index that was built before the account was listed.
const demoIndexer = "demo"

// demoAllows says whether a demo account may make this request; r.Pattern is the route it matched.
func demoAllows(r *http.Request) bool {
	return r.Method == http.MethodGet || r.Method == http.MethodHead || demoAllowed[r.Pattern]
}
