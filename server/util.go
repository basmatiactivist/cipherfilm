package main

import (
	"database/sql"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/mail"
	"strings"
	"time"
)

var b64 = base64.RawURLEncoding

func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func randToken() string { return b64.EncodeToString(randBytes(32)) }
func randID() string    { return hex.EncodeToString(randBytes(16)) }

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func hmacSum(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}

func ctEqual(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

func normEmail(e string) (string, bool) {
	e = strings.ToLower(strings.TrimSpace(e))
	if len(e) > 254 || len(e) < 3 {
		return "", false
	}
	a, err := mail.ParseAddress(e)
	if err != nil || a.Address != e {
		return "", false
	}
	return e, true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// readJSON enforces a small body cap and rejects unknown fields.
// A body that trickles in slower than jsonReadTime is cut off, so slow clients cannot hold handlers open.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	bodyDeadline(w, jsonReadTime)
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		fail(w, http.StatusBadRequest, "invalid request")
		return false
	}
	return true
}

var (
	jsonReadTime   = 30 * time.Second
	uploadReadTime = 15 * time.Minute // one encrypted part (about 4.2 MB) on a slow mobile connection
)

// bodyDeadline limits how long reading this request's body may take. The server sets no overall read timeout
// because uploads need far longer than everything else.
func bodyDeadline(w http.ResponseWriter, d time.Duration) {
	http.NewResponseController(w).SetReadDeadline(time.Now().Add(d)) // unsupported (tests): no limit
}

// rowsAffected is safe to call when the statement failed: res may be nil then, and a nil Result must not be dereferenced.
func rowsAffected(res sql.Result, err error) int64 {
	if err != nil || res == nil {
		return 0
	}
	n, _ := res.RowsAffected()
	return n
}
