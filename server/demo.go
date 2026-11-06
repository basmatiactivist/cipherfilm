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
	// search: index entries the account's own devices computed (bounded by its storage limit) and taking the indexing
	// role. Not the people document (names one visitor types would show to the next) and not deleting the index (one
	// visitor would break search for everyone until the daily reset).
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

// demoAllows says whether a demo account may make this request; r.Pattern is the route it matched.
func demoAllows(r *http.Request) bool {
	return r.Method == http.MethodGet || r.Method == http.MethodHead || demoAllowed[r.Pattern]
}
