package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
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
	http.SetCookie(w, &http.Cookie{Name: deviceCookie, Value: u.ID + "." + a.deviceMAC(u.ID, u.AuthHash), Path: "/",
		MaxAge: 180 * 24 * 3600, HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
}
