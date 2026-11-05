package main

import (
	"encoding/json"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
)

// Request bodies, paths, query strings and forwarded headers come from anyone who can reach the server: the checks
// below must hold for any input, not only the ones the apps send. `go test` runs the seeds; `go test -fuzz=Name` explores.

func FuzzModelFamily(f *testing.F) {
	for _, s := range []string{"", "laionb32+yunet23+sface21/1", "mcs2/2", "nsfw-x", "../etc", "A+b", "+", strings.Repeat("a", 80)} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, tag string) {
		fam := modelFamily(tag)
		if fam == "" {
			return
		}
		if !modelNameRe.MatchString(fam) || !strings.HasPrefix(tag, fam) || strings.ContainsAny(fam, "+/") {
			t.Fatalf("modelFamily(%q) = %q", tag, fam)
		}
		if rest := tag[len(fam):]; rest != "" && rest[0] != '+' && rest[0] != '/' {
			t.Fatalf("modelFamily(%q) = %q cut mid-name", tag, fam)
		}
	})
}

func FuzzClientIPAndLimiterKey(f *testing.F) {
	f.Add("127.0.0.1:1234", "8.8.8.8")
	f.Add("127.0.0.1:1234", "1.1.1.1, 2001:db8::1")
	f.Add("10.0.0.1:80", "evil, ")
	f.Add("[::1]:443", "::ffff:1.2.3.4")
	f.Add("203.0.113.9:5", "8.8.8.8")
	f.Add("garbage", "")
	a := &App{trustProxy: true}
	f.Fuzz(func(t *testing.T, remote, xff string) {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		ip := a.clientIP(r)
		if !a.fromProxy(remote) && strings.Contains(xff, ip) && ip != "" && !strings.Contains(remote, ip) {
			t.Fatalf("an untrusted peer %q set its address to %q", remote, ip)
		}
		if _, err := netip.ParseAddr(ip); err != nil && !strings.Contains(remote, ip) {
			t.Fatalf("clientIP = %q: neither an address nor the peer's own", ip)
		}
		key := limiterIP(ip)
		if limiterIP(key) != key {
			t.Fatalf("limiterIP(%q) = %q is not stable", ip, key)
		}
		if addr, err := netip.ParseAddr(ip); err == nil && addr.Unmap().Is6() {
			if p, err := netip.ParsePrefix(key); err != nil || p.Bits() != 64 || !p.Contains(addr.Unmap().WithZone("")) {
				t.Fatalf("limiterIP(%q) = %q, want its /64", ip, key)
			}
		}
	})
}

func FuzzKeyBundle(f *testing.F) {
	k32 := b64.EncodeToString(make([]byte, 32))
	w := b64.EncodeToString(make([]byte, wrappedLen))
	good, _ := json.Marshal(keyBundle{
		KDF:  kdfParams{Alg: "argon2id13", V: 1, Ops: 3, Mem: 64 << 20, Salt: b64.EncodeToString(make([]byte, 16))},
		Auth: k32, Pubkey: k32, RecoveryVerifier: k32, WrappedMasterPW: w, WrappedMasterRecovery: w, WrappedPrivkey: w,
	})
	f.Add(good)
	f.Add([]byte(`{"kdf":{"alg":"argon2id13","v":1,"ops":99,"mem":1}}`))
	f.Add([]byte(`{}`))
	f.Add([]byte(`null`))
	f.Fuzz(func(t *testing.T, body []byte) {
		var b keyBundle
		if json.Unmarshal(body, &b) != nil || b.validate() != nil {
			return
		}
		if b.KDF.Ops < minOps || b.KDF.Ops > maxOps || b.KDF.Mem < minMem || b.KDF.Mem > maxMem {
			t.Fatalf("weak or huge kdf accepted: %+v", b.KDF)
		}
		for _, s := range []string{b.Auth, b.Pubkey, b.RecoveryVerifier, b.WrappedMasterPW, b.WrappedMasterRecovery, b.WrappedPrivkey, b.KDF.Salt} {
			if _, err := b64.DecodeString(s); err != nil {
				t.Fatalf("undecodable field %q accepted", s)
			}
		}
	})
}

func FuzzBlobChecks(f *testing.F) {
	f.Add(b64.EncodeToString(make([]byte, 1+24+16)))
	f.Add(b64.EncodeToString(make([]byte, 2000)))
	f.Add("")
	f.Add("!!!not base64")
	f.Fuzz(func(t *testing.T, s string) {
		b, err := b64.DecodeString(s)
		if blobOK(s, maxIndexBytes) && (err != nil || len(b) < 1+24+16 || len(b) > maxIndexBytes) {
			t.Fatalf("blobOK(%q)", s)
		}
		if nameOK(s) && (err != nil || len(b) < 1+24+16 || len(b) > 1024) {
			t.Fatalf("nameOK(%q)", s)
		}
	})
}

func FuzzPageAfter(f *testing.F) {
	f.Add("1700000000000.0123456789abcdef0123456789abcdef")
	f.Add("")
	f.Add("x.y")
	f.Add("-1.0123456789abcdef0123456789abcdef\n")
	f.Fuzz(func(t *testing.T, v string) {
		r := httptest.NewRequest("GET", "/api/items?after="+url.QueryEscape(v), nil)
		_, id, has, ok := pageAfter(r)
		if has && (!ok || !idRe.MatchString(id)) {
			t.Fatalf("pageAfter(%q) = %q, %v, %v", v, id, has, ok)
		}
	})
}

func FuzzNormEmail(f *testing.F) {
	for _, s := range []string{"Vector.User@Example.com", " a@b.c ", "a@b", "<a@b.c>", "x <a@b.c>", "", strings.Repeat("a", 300) + "@b.c"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		e, ok := normEmail(in)
		if !ok {
			return
		}
		if e != strings.ToLower(e) || e != strings.TrimSpace(e) || len(e) < 3 || len(e) > 254 || strings.ContainsAny(e, "<> \r\n") {
			t.Fatalf("normEmail(%q) = %q", in, e)
		}
		if again, ok := normEmail(e); !ok || again != e {
			t.Fatalf("normEmail(%q) = %q, then %q", in, e, again)
		}
	})
}
