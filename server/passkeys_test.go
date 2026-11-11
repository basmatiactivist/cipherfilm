package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
)

// A software authenticator: what a browser and a passkey provider together send back, made here with an ECDSA key.

const rpHost = "photos.test"

type softKey struct {
	t      *testing.T
	priv   *ecdsa.PrivateKey
	id     []byte
	origin string // what the client puts in clientDataJSON
	rpID   string // what the authenticator hashes into its data ("" = the challenge's)
	count  uint32
	user   []byte
}

func newSoftKey(t *testing.T) *softKey {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &softKey{t: t, priv: priv, id: randBytes(16), origin: "https://" + rpHost}
}

var b64u = base64.RawURLEncoding

func (k *softKey) authData(rpID string, flags byte, attested bool) []byte {
	h := sha256.Sum256([]byte(rpID))
	b := append(h[:], flags)
	b = binary.BigEndian.AppendUint32(b, k.count)
	if attested {
		b = append(b, make([]byte, 16)...) // AAGUID
		b = binary.BigEndian.AppendUint16(b, uint16(len(k.id)))
		b = append(b, k.id...)
		pub, err := k.priv.PublicKey.ECDH()
		if err != nil {
			k.t.Fatal(err)
		}
		raw := pub.Bytes() // 0x04 | X | Y
		cose, err := webauthncbor.Marshal(webauthncose.EC2PublicKeyData{
			PublicKeyData: webauthncose.PublicKeyData{KeyType: int64(webauthncose.EllipticKey), Algorithm: int64(webauthncose.AlgES256)},
			Curve:         1, XCoord: raw[1:33], YCoord: raw[33:65],
		})
		if err != nil {
			k.t.Fatal(err)
		}
		b = append(b, cose...)
	}
	return b
}

func clientData(typ, challenge, origin string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false})
	return b
}

// create answers registration options (the "options" of register/begin).
func (k *softKey) create(opts map[string]any) map[string]any {
	k.t.Helper()
	rp := opts["rp"].(map[string]any)["id"].(string)
	if k.rpID != "" {
		rp = k.rpID
	}
	k.user, _ = b64u.DecodeString(opts["user"].(map[string]any)["id"].(string))
	att, err := webauthncbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": k.authData(rp, 0x01|0x04|0x40, true)})
	if err != nil {
		k.t.Fatal(err)
	}
	return map[string]any{"id": b64u.EncodeToString(k.id), "rawId": b64u.EncodeToString(k.id), "type": "public-key",
		"response": map[string]any{"clientDataJSON": b64u.EncodeToString(clientData("webauthn.create", opts["challenge"].(string), k.origin)),
			"attestationObject": b64u.EncodeToString(att), "transports": []string{"internal"}},
		// as Android's Credential Manager and some browsers send it without being asked
		"clientExtensionResults": map[string]any{"credProps": map[string]any{"rk": true}}}
}

// get answers assertion options; the signature counter moves forward first.
func (k *softKey) get(opts map[string]any) map[string]any {
	k.t.Helper()
	k.count++
	rp := opts["rpId"].(string)
	if k.rpID != "" {
		rp = k.rpID
	}
	ad := k.authData(rp, 0x01|0x04, false)
	cd := clientData("webauthn.get", opts["challenge"].(string), k.origin)
	h := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), h[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, k.priv, digest[:])
	if err != nil {
		k.t.Fatal(err)
	}
	return map[string]any{"id": b64u.EncodeToString(k.id), "rawId": b64u.EncodeToString(k.id), "type": "public-key",
		"response": map[string]any{"clientDataJSON": b64u.EncodeToString(cd), "authenticatorData": b64u.EncodeToString(ad),
			"signature": b64u.EncodeToString(sig), "userHandle": b64u.EncodeToString(k.user)},
		"clientExtensionResults": map[string]any{}}
}

// ---- helpers ----

func (e *env) hostClient() *client {
	c := e.client()
	c.host = rpHost
	return c
}

// addPasskey adds a passkey for a signed-in client; extra is the second step (code or passkey) when one is needed.
func (e *env) addPasskey(c *client, b map[string]any, k *softKey, extra ...any) map[string]any {
	e.t.Helper()
	code, out := c.do("POST", "/api/me/passkeys/register/begin", with(map[string]any{"current_auth": b["auth"]}, extra...), true)
	if code != 200 {
		e.t.Fatalf("register begin: %d %v", code, out)
	}
	code, out = c.do("POST", "/api/me/passkeys/register/finish", map[string]any{"name": "My phone", "credential": k.create(out["options"].(map[string]any))}, true)
	if code != 200 {
		e.t.Fatalf("register finish: %d %v", code, out)
	}
	return out
}

func (e *env) passkeyChallenge(c *client, pending string) map[string]any {
	e.t.Helper()
	r := c.post("/api/auth/login/2fa/passkey", map[string]any{"pending": pending})
	if r.code != 200 {
		e.t.Fatalf("passkey challenge: %d %v", r.code, r.body)
	}
	return r.body["options"].(map[string]any)
}

// proofPasskey answers a signed-in session's challenge, for the changes that need a second step.
func (e *env) proofPasskey(c *client, k *softKey) map[string]any {
	e.t.Helper()
	code, out := c.do("POST", "/api/me/2fa/passkey", map[string]any{}, true)
	if code != 200 {
		e.t.Fatalf("proof challenge: %d %v", code, out)
	}
	return k.get(out["options"].(map[string]any))
}

func (e *env) adminWithPasskey() (*client, map[string]any, *softKey, []string) {
	c := e.hostClient()
	b := with(bundle(), "setup_token", e.knownSetupToken(), "email", "admin@x.org")
	if code, out := c.do("POST", "/api/setup", b, false); code != 201 {
		e.t.Fatalf("setup: %d %v", code, out)
	}
	k := newSoftKey(e.t)
	out := e.addPasskey(c, b, k)
	var codes []string
	for _, x := range out["recovery_codes"].([]any) {
		codes = append(codes, x.(string))
	}
	return c, b, k, codes
}

// ---- the flows ----

func TestPasskeyIsASecondStep(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	admin, ab, k, codes := e.adminWithPasskey()
	if len(codes) != 10 {
		t.Fatalf("the first second step makes the recovery codes: %v", codes)
	}
	if _, out := admin.do("GET", "/api/me", nil, false); out["two_factor"] != true {
		t.Fatal("two-step sign-in not on")
	}
	if _, out := admin.do("GET", "/api/me/2fa", nil, false); out["enabled"] != true || out["totp"] != false || out["passkeys"] != float64(1) || out["recovery_codes_left"] != float64(10) {
		t.Fatalf("status: %v", out)
	}
	if _, out := admin.do("GET", "/api/me/passkeys", nil, false); !strings.Contains(mustJSON(out), `"name":"My phone"`) || !strings.Contains(mustJSON(out), `"here":true`) {
		t.Fatalf("list: %v", out)
	}
	// the record is sealed: neither the public key nor the counter can be read or edited in the database alone
	var stored string
	e.app.db.QueryRow(`SELECT cred FROM passkeys`).Scan(&stored)
	if !strings.HasPrefix(stored, "1.") || strings.Contains(stored, "signCount") {
		t.Fatalf("stored in the clear: %q", stored)
	}

	// the password step gives nothing but the pending token, and says a passkey can follow
	c := e.hostClient()
	r := c.post("/api/auth/login", map[string]any{"email": "admin@x.org", "auth": ab["auth"]})
	if r.code != 401 || r.body["passkey"] != true || r.body["totp"] != false {
		t.Fatalf("password step: %d %v", r.code, r.body)
	}
	for _, f := range []string{"csrf", "wrapped_master_pw", "wrapped_privkey", "kdf"} {
		if _, ok := r.body[f]; ok {
			t.Fatalf("%s before the second step", f)
		}
	}
	if len(r.header.Values("Set-Cookie")) != 0 {
		t.Fatal("a cookie before the second step")
	}
	pending := r.body["pending"].(string)
	opts := e.passkeyChallenge(c, pending)
	if opts["rpId"] != rpHost || len(opts["allowCredentials"].([]any)) != 1 {
		t.Fatalf("options: %v", opts)
	}
	r = c.post("/api/auth/login/2fa", map[string]any{"pending": pending, "passkey": k.get(opts)})
	if r.code != 200 || r.body["wrapped_master_pw"] == nil {
		t.Fatalf("passkey: %d %v", r.code, r.body)
	}
	if code, _ := c.do("GET", "/api/me", nil, false); code != 200 {
		t.Fatalf("session: %d", code)
	}
	var last int64
	e.app.db.QueryRow(`SELECT last_used_at FROM passkeys`).Scan(&last)
	if last == 0 {
		t.Fatal("last use not recorded")
	}
	// a recovery code still works instead
	c2 := e.hostClient()
	p := e.passwordStep(c2, "admin@x.org", ab)
	if r := c2.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codes[0]}); r.code != 200 {
		t.Fatalf("recovery code: %d %v", r.code, r.body)
	}
	_ = admin
}

func TestPasskeyAnswersAreCheckedStrictly(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	_, ab, k, _ := e.adminWithPasskey()
	c := e.hostClient()
	// a second apart: a fourth open sign-in pushes out the oldest, and that must be the oldest
	step := func() string { clk.tick(time.Second); return e.passwordStep(c, "admin@x.org", ab) }
	tryWith := func(mutate func(k *softKey, opts map[string]any) map[string]any) rawResp {
		t.Helper()
		p := step()
		opts := e.passkeyChallenge(c, p)
		return c.post("/api/auth/login/2fa", map[string]any{"pending": p, "passkey": mutate(k, opts)})
	}
	refused := func(name string, r rawResp) {
		t.Helper()
		if r.code != 401 || r.body["code"] != "wrong_passkey" {
			t.Fatalf("%s: %d %v", name, r.code, r.body)
		}
		// so the next check isn't stopped by the code limit
		e.app.totpAcct.clear("2fa|" + mustUserID(e, "admin@x.org"))
		e.app.totpDay.clear("2fa|" + mustUserID(e, "admin@x.org"))
	}
	// another origin (a look-alike page)
	refused("wrong origin", tryWith(func(k *softKey, o map[string]any) map[string]any {
		k.origin = "https://photos.test.evil.example"
		defer func() { k.origin = "https://" + rpHost }()
		return k.get(o)
	}))
	// the authenticator signed for another relying party
	refused("wrong rp", tryWith(func(k *softKey, o map[string]any) map[string]any {
		k.rpID = "evil.example"
		defer func() { k.rpID = "" }()
		return k.get(o)
	}))
	// a challenge that wasn't this one
	refused("made-up challenge", tryWith(func(k *softKey, o map[string]any) map[string]any {
		o["challenge"] = b64u.EncodeToString(randBytes(32))
		return k.get(o)
	}))
	// a signature counter that goes back: a copied authenticator
	r := tryWith(func(k *softKey, o map[string]any) map[string]any { k.count = 40; return k.get(o) })
	if r.code != 200 {
		t.Fatalf("counter forward: %d %v", r.code, r.body)
	}
	refused("counter back", tryWith(func(k *softKey, o map[string]any) map[string]any { k.count = 10; return k.get(o) }))
	k.count = 100

	// a challenge is answered once: the same right answer again is refused
	p := step()
	opts := e.passkeyChallenge(c, p)
	good := k.get(opts)
	bad := k.get(opts)
	bad["response"].(map[string]any)["signature"] = b64u.EncodeToString(randBytes(70))
	refused("bad signature", c.post("/api/auth/login/2fa", map[string]any{"pending": p, "passkey": bad}))
	refused("replayed challenge", c.post("/api/auth/login/2fa", map[string]any{"pending": p, "passkey": good}))
	// and an answer from one finished sign-in doesn't open another
	opts = e.passkeyChallenge(c, p)
	good = k.get(opts)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "passkey": good}); r.code != 200 {
		t.Fatalf("right answer: %d %v", r.code, r.body)
	}
	p2 := step()
	e.passkeyChallenge(c, p2)
	refused("answer of another sign-in", c.post("/api/auth/login/2fa", map[string]any{"pending": p2, "passkey": good}))

	// bound to its pending token: the answer to one sign-in's challenge doesn't finish another's
	pa := step()
	pb := step()
	oa := e.passkeyChallenge(c, pa)
	e.passkeyChallenge(c, pb)
	refused("other pending", c.post("/api/auth/login/2fa", map[string]any{"pending": pb, "passkey": k.get(oa)}))
	// without a challenge of its own
	pc := step()
	refused("no challenge", c.post("/api/auth/login/2fa", map[string]any{"pending": pc, "passkey": k.get(oa)}))
	// a wrong answer counts like a wrong code: five wear the sign-in out
	pd := step()
	for i := 0; i < pendingTries; i++ {
		e.app.totpAcct.clear("2fa|" + mustUserID(e, "admin@x.org"))
		e.app.totpDay.clear("2fa|" + mustUserID(e, "admin@x.org"))
		e.passkeyChallenge(c, pd)
		c.post("/api/auth/login/2fa", map[string]any{"pending": pd, "passkey": bad})
	}
	if r := c.post("/api/auth/login/2fa/passkey", map[string]any{"pending": pd}); r.code != 401 || r.body["code"] != "two_factor_expired" {
		t.Fatalf("worn out: %d %v", r.code, r.body)
	}
}

func mustUserID(e *env, email string) string {
	u, err := e.app.userByEmail(email)
	if err != nil {
		e.t.Fatal(err)
	}
	return u.ID
}

func TestPasskeyBelongsToItsName(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	_, ab, k, _ := e.adminWithPasskey()
	// reached by another name, the account has no passkey there
	c := e.client()
	c.host = "other.test"
	p := e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa/passkey", map[string]any{"pending": p}); r.code != 409 || r.body["code"] != "no_passkey" {
		t.Fatalf("other name: %d %v", r.code, r.body)
	}
	// a challenge begun under one name isn't answered under another
	h := e.hostClient()
	p = e.passwordStep(h, "admin@x.org", ab)
	opts := e.passkeyChallenge(h, p)
	c.c = h.c
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "passkey": k.get(opts)}); r.code != 401 || r.body["code"] != "wrong_passkey" {
		t.Fatalf("answered under another name: %d %v", r.code, r.body)
	}
	// never by an address: a passkey needs a name
	ip := e.client()
	p = e.passwordStep(ip, "admin@x.org", ab)
	if r := ip.post("/api/auth/login/2fa/passkey", map[string]any{"pending": p}); r.code != 409 || r.body["code"] != "passkeys_unavailable" {
		t.Fatalf("by address: %d %v", r.code, r.body)
	}
	// with PUBLIC_HOSTS, only those names
	if _, _, err := (&App{hosts: map[string]bool{"a.test": true}}).rpName(&http.Request{Host: "b.test"}); err == nil {
		t.Fatal("a name outside PUBLIC_HOSTS")
	}
	if name, origin, err := (&App{}).rpName(&http.Request{Host: "Photos.Test:8443"}); err != nil || name != "photos.test" || origin != "https://photos.test:8443" {
		t.Fatalf("with a port: %q %q %v", name, origin, err)
	}
}

func TestPasskeyFromTheAndroidApp(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	_, ab, k, _ := e.adminWithPasskey()
	fp, _ := hex.DecodeString(strings.ReplaceAll(defaultAndroidCerts, ":", ""))
	k.origin = "android:apk-key-hash:" + b64u.EncodeToString(fp)
	c := e.hostClient()
	p := e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "passkey": k.get(e.passkeyChallenge(c, p))}); r.code != 200 {
		t.Fatalf("the app's origin: %d %v", r.code, r.body)
	}
	k.origin = "android:apk-key-hash:" + b64u.EncodeToString(randBytes(32)) // an app signed with another key
	p = e.passwordStep(c, "admin@x.org", ab)
	if r := c.post("/api/auth/login/2fa", map[string]any{"pending": p, "passkey": k.get(e.passkeyChallenge(c, p))}); r.code != 401 {
		t.Fatalf("another app: %d %v", r.code, r.body)
	}
	// Android checks the server's statement before it lets the app use the passkeys
	resp, err := e.hostClient().c.Get(e.srv.URL + "/.well-known/assetlinks.json")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var links []map[string]any
	json.NewDecoder(resp.Body).Decode(&links)
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") || len(links) != 1 ||
		!strings.Contains(mustJSON(links), "delegate_permission/common.get_login_creds") || !strings.Contains(mustJSON(links), defaultAndroidCerts) ||
		!strings.Contains(mustJSON(links), `"package_name":"app.cipherfilm"`) {
		t.Fatalf("assetlinks: %d %v", resp.StatusCode, links)
	}
}

func TestAndroidAppsSetting(t *testing.T) {
	x, err := androidSetting("app.cipherfilm app.cipherfilm.test", "87d9e9ab855b03e7d7d3152f5a76a4d8afb5d38efca3b9932ad93f1ba17c6712, FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C")
	if err != nil || len(x.packages) != 2 || len(x.certs) != 2 || !strings.HasPrefix(x.origins()[0], "android:apk-key-hash:h9np") {
		t.Fatalf("%+v %v", x, err)
	}
	if x, err := androidSetting("", "none"); err != nil || len(x.certs) != 0 {
		t.Fatalf("none: %+v %v", x, err)
	}
	if _, err := androidSetting("", "abcd"); err == nil {
		t.Fatal("a short fingerprint")
	}
	t.Setenv("ANDROID_APP_CERTS", "none")
	e := newEnv(t)
	resp, err := e.client().c.Get(e.srv.URL + "/.well-known/assetlinks.json")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("without apps: %d", resp.StatusCode)
	}
}

func TestChangingPasskeysNeedsASecondStep(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab, k, codes := e.adminWithPasskey()

	// adding another needs the password and a second step now
	k2 := newSoftKey(t)
	if code, out := admin.do("POST", "/api/me/passkeys/register/begin", map[string]any{"current_auth": ab["auth"]}, true); code != 403 || out["code"] != "wrong_code" {
		t.Fatalf("without a second step: %d %v", code, out)
	}
	if code, _ := admin.do("POST", "/api/me/passkeys/register/begin", map[string]any{"current_auth": rb(32), "passkey": e.proofPasskey(admin, k)}, true); code != 403 {
		t.Fatalf("wrong password: %d", code)
	}
	out := e.addPasskey(admin, ab, k2, "passkey", e.proofPasskey(admin, k))
	if _, ok := out["recovery_codes"]; ok {
		t.Fatal("new recovery codes for a second passkey")
	}
	// the same authenticator twice: refused by the authenticator (excluded), and by the server
	code, begin := admin.do("POST", "/api/me/passkeys/register/begin", map[string]any{"current_auth": ab["auth"], "code": codes[1]}, true)
	if code != 200 || len(begin["options"].(map[string]any)["excludeCredentials"].([]any)) != 2 {
		t.Fatalf("exclusions: %d %v", code, begin)
	}
	if code, out := admin.do("POST", "/api/me/passkeys/register/finish", map[string]any{"credential": k2.create(begin["options"].(map[string]any))}, true); code != 409 {
		t.Fatalf("twice: %d %v", code, out)
	}
	// a registration is used up and bound to its session
	if code, _ := admin.do("POST", "/api/me/passkeys/register/finish", map[string]any{"credential": newSoftKey(t).create(begin["options"].(map[string]any))}, true); code != 409 {
		t.Fatalf("finished twice: %d", code)
	}

	// an authenticator app on top: needs a second step, and keeps the recovery codes
	if code, _ := admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"]}, true); code != 403 {
		t.Fatalf("setup without a second step: %d", code)
	}
	code, setup := admin.do("POST", "/api/me/2fa/setup", map[string]any{"current_auth": ab["auth"], "passkey": e.proofPasskey(admin, k)}, true)
	if code != 200 {
		t.Fatalf("setup: %d %v", code, setup)
	}
	code, out = admin.do("POST", "/api/me/2fa/enable", map[string]any{"code": codeAt(t, setup["secret"].(string), clk.at)}, true)
	if code != 200 || out["recovery_codes"] != nil {
		t.Fatalf("enable: %d %v", code, out)
	}
	if _, st := admin.do("GET", "/api/me/2fa", nil, false); st["totp"] != true || st["passkeys"] != float64(2) || st["recovery_codes_left"] != float64(9) {
		t.Fatalf("status: %v", st)
	}
	clk.tick(30 * time.Second)
	// the authenticator app removed again: the passkeys stay, so does two-step sign-in
	if code, out := admin.do("POST", "/api/me/2fa/totp/remove", map[string]any{"current_auth": ab["auth"], "code": codeAt(t, setup["secret"].(string), clk.at)}, true); code != 200 || out["two_factor"] != true {
		t.Fatalf("remove the app: %d %v", code, out)
	}

	// rename
	_, l := admin.do("GET", "/api/me/passkeys", nil, false)
	keys := l["passkeys"].([]any)
	id1, id2 := keys[0].(map[string]any)["id"].(string), keys[1].(map[string]any)["id"].(string)
	if code, _ := admin.do("PATCH", "/api/me/passkeys/"+id1, map[string]any{"name": "  Laptop   key "}, true); code != 200 {
		t.Fatalf("rename: %d", code)
	}
	if code, _ := admin.do("PATCH", "/api/me/passkeys/"+id1, map[string]any{"name": strings.Repeat("x", 65)}, true); code != 400 {
		t.Fatalf("long name: %d", code)
	}
	if _, l := admin.do("GET", "/api/me/passkeys", nil, false); !strings.Contains(mustJSON(l), `"name":"Laptop key"`) {
		t.Fatalf("renamed: %v", l)
	}

	// removing one needs the password and a second step; the last one turns two-step sign-in off
	if code, _ := admin.do("DELETE", "/api/me/passkeys/"+id1, map[string]any{"current_auth": ab["auth"]}, true); code != 403 {
		t.Fatalf("delete without a second step: %d", code)
	}
	if code, out := admin.do("DELETE", "/api/me/passkeys/"+id1, map[string]any{"current_auth": ab["auth"], "passkey": e.proofPasskey(admin, k)}, true); code != 200 || out["two_factor"] != true {
		t.Fatalf("delete one: %d %v", code, out)
	}
	if code, out := admin.do("DELETE", "/api/me/passkeys/"+id2, map[string]any{"current_auth": ab["auth"], "code": codes[2]}, true); code != 200 || out["two_factor"] != false {
		t.Fatalf("delete the last: %d %v", code, out)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM recovery_codes`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d recovery codes left behind", n)
	}
	e.login("admin@x.org", ab) // the password alone again
	_, audit := admin.do("GET", "/api/admin/audit", nil, false)
	for _, s := range []string{"added a passkey", "removed a passkey", "added an authenticator app", "removed the authenticator app"} {
		if !strings.Contains(mustJSON(audit), s) {
			t.Fatalf("audit lacks %q: %v", s, audit)
		}
	}
}

func TestTurningOffRemovesPasskeys(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	admin, ab, k, _ := e.adminWithPasskey()
	// (the cookie jar keys cookies by the name the server is reached by: a client keeps one name throughout)
	bob, bb := e.hostClient(), bundle()
	if code, out := bob.do("POST", "/api/invites/"+e.invite(admin, "bob@x.org")+"/accept", bb, false); code != 201 {
		t.Fatalf("accept: %d %v", code, out)
	}
	e.addPasskey(bob, bb, newSoftKey(t))
	// the person: password and a passkey
	if code, out := admin.do("POST", "/api/me/2fa/disable", map[string]any{"current_auth": ab["auth"], "passkey": e.proofPasskey(admin, k)}, true); code != 200 {
		t.Fatalf("disable: %d %v", code, out)
	}
	// an administrator, for someone who lost theirs; a waiting sign-in ends with it
	if _, out := admin.do("GET", "/api/admin/users", nil, false); !strings.Contains(mustJSON(out), `"two_factor":true`) {
		t.Fatalf("admin list: %v", out)
	}
	w := e.hostClient()
	p := e.passwordStep(w, "bob@x.org", bb)
	if code, out := admin.do("DELETE", "/api/admin/users/"+mustUserID(e, "bob@x.org")+"/2fa", nil, true); code != 200 {
		t.Fatalf("admin reset: %d %v", code, out)
	}
	if r := w.post("/api/auth/login/2fa/passkey", map[string]any{"pending": p}); r.code != 401 {
		t.Fatalf("pending after reset: %d %v", r.code, r.body)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM passkeys`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d passkeys left", n)
	}
	e.login("bob@x.org", bb)
	// and the console's reset-2fa
	e.addPasskey(bob, bb, newSoftKey(t))
	if out, err := e.cli("reset-2fa", "bob@x.org"); err != nil || !strings.Contains(out, "is off") {
		t.Fatalf("reset-2fa: %v %q", err, out)
	}
	e.app.db.QueryRow(`SELECT COUNT(*) FROM passkeys`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d passkeys left after reset-2fa", n)
	}
}

func TestDemoCannotAddPasskeys(t *testing.T) {
	_, _, demo, _, _ := demoEnv(t)
	if code, out := demo.do("POST", "/api/me/passkeys/register/begin", map[string]any{"current_auth": rb(32)}, true); code != 403 || out["error"] != demoRefused {
		t.Fatalf("demo: %d %v", code, out)
	}
	if code, out := demo.do("GET", "/api/me/passkeys", nil, false); code != 200 || out["available"] != false {
		t.Fatalf("demo list: %d %v", code, out)
	}
}

func TestPasskeySignInIsRateLimited(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	_, ab, k, _ := e.adminWithPasskey()
	c := e.hostClient()
	bad := func(p string) rawResp {
		a := k.get(e.passkeyChallenge(c, p))
		a["response"].(map[string]any)["signature"] = b64u.EncodeToString(randBytes(70))
		return c.post("/api/auth/login/2fa", map[string]any{"pending": p, "passkey": a})
	}
	var last rawResp
	for i := 0; i < totpAcctMax+1; i++ {
		last = bad(e.passwordStep(c, "admin@x.org", ab))
	}
	if last.code != 429 {
		t.Fatalf("the account's bucket: %d %v", last.code, last.body)
	}
}

// A passkey added or removed after the backup stays so after a restore, like the rest of two-step sign-in.
func TestRestoreKeepsLaterPasskeyChanges(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	admin, ab, k1, codes := e.adminWithPasskey()
	if err := runBackup(e.app.dataDir); err != nil {
		t.Fatal(err)
	}
	k2 := newSoftKey(t)
	e.addPasskey(admin, ab, k2, "passkey", e.proofPasskey(admin, k1))
	_, l := admin.do("GET", "/api/me/passkeys", nil, false)
	var first string
	for _, x := range l["passkeys"].([]any) {
		if p := x.(map[string]any); p["id"] != nil {
			var cred string
			e.app.db.QueryRow(`SELECT cred_id FROM passkeys WHERE id=?`, p["id"]).Scan(&cred)
			if cred == b64u.EncodeToString(k1.id) {
				first = p["id"].(string)
			}
		}
	}
	if code, out := admin.do("DELETE", "/api/me/passkeys/"+first, map[string]any{"current_auth": ab["auth"], "code": codes[0]}, true); code != 200 {
		t.Fatalf("remove: %d %v", code, out)
	}
	app2 := restoredApp(t, e)
	rows, err := app2.db.Query(`SELECT cred_id FROM passkeys`)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var c string
		rows.Scan(&c)
		got = append(got, c)
	}
	rows.Close()
	if len(got) != 1 || got[0] != b64u.EncodeToString(k2.id) {
		t.Fatalf("after the restore: %v", got)
	}
	u, _ := app2.userByEmail("admin@x.org")
	if l, err := app2.passkeysOf(u.ID, rpHost); err != nil || len(l) != 1 {
		t.Fatalf("readable after the restore: %v %v", l, err)
	}
}
