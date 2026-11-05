package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
	naclbox "golang.org/x/crypto/nacl/box"
)

// Everything a backup folder holds is untrusted: the parsers below must reject any bytes cleanly, never panic,
// and only ever accept what they were built to accept. `go test` runs the seeds; `go test -fuzz=Name` explores.

var fuzzKey = bytes.Repeat([]byte{7}, 32)

const fuzzID = "0123456789abcdef0123456789abcdef"

func sealFor(t testing.TB, plain, key []byte, label, owner string) []byte {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		t.Fatal(err)
	}
	nonce := bytes.Repeat([]byte{1}, 24)
	return aead.Seal(append([]byte{1}, nonce...), nonce, plain, adFor(label, owner))
}

func FuzzOpenWrapped(f *testing.F) {
	f.Add(sealFor(f, []byte("item key"), fuzzKey, "wrap/item", fuzzID), "wrap/item", fuzzID)
	f.Add(sealFor(f, append([]byte(`{"name":"a.jpg"}`), 0x80, 0, 0), fuzzKey, "meta", fuzzID), "meta", fuzzID)
	f.Add([]byte{1}, "", "")
	f.Add([]byte{}, "meta", "x")
	f.Fuzz(func(t *testing.T, blob []byte, label, owner string) {
		pt, err := open(blob, fuzzKey, label, owner)
		if err == nil && len(pt) != len(blob)-1-24-16 {
			t.Fatalf("opened %d bytes from a %d-byte blob", len(pt), len(blob))
		}
		decryptMeta(blob, fuzzKey, owner)
		decryptAlbumName(blob, fuzzKey, owner)
	})
}

func FuzzUnpad(f *testing.F) {
	f.Add([]byte{0x80})
	f.Add([]byte{'a', 0x80, 0, 0})
	f.Add([]byte{0, 0})
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, b []byte) {
		out, err := unpad(b)
		if err != nil {
			return
		}
		if len(out) >= len(b) || b[len(out)] != 0x80 || !bytes.Equal(out, b[:len(out)]) {
			t.Fatalf("unpad(%x) = %x", b, out)
		}
	})
}

func FuzzOpenSealedItemKey(f *testing.F) {
	pub, priv, err := naclbox.GenerateKey(rand.Reader)
	if err != nil {
		f.Fatal(err)
	}
	pk, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil || !bytes.Equal(pk, pub[:]) {
		f.Fatal("key pair mismatch")
	}
	idBytes := []byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}
	sealed, err := naclbox.SealAnonymous([]byte{2}, append(bytes.Repeat([]byte{9}, 32), idBytes...), pub, rand.Reader)
	if err != nil {
		f.Fatal(err)
	}
	f.Add(sealed, fuzzID)
	f.Add(sealed, "ffffffffffffffffffffffffffffffff")
	f.Add(make([]byte, sealedItemKeyLen), fuzzID)
	f.Add([]byte{2}, "zz")
	ring := &keyRing{master: fuzzKey, pk: pk, sk: priv[:]}
	f.Fuzz(func(t *testing.T, blob []byte, itemID string) {
		k, err := openSealedItemKey(blob, pk, priv[:], itemID)
		if err == nil && (len(k) != 32 || strings.ToLower(itemID) != fuzzID) {
			t.Fatalf("sealed key for %q opened (%d bytes)", itemID, len(k))
		}
		ring.itemKey(blob, itemID)
	})
}

func FuzzDecryptSegment(f *testing.F) {
	var v struct {
		Files []struct {
			ID          string
			Size, Count int64
			Segment0    string
		}
	}
	if raw, err := os.ReadFile("testdata/vectors.json"); err == nil && json.Unmarshal(raw, &v) == nil {
		for _, file := range v.Files {
			f.Add(mustB64(file.Segment0), file.ID, int64(0), file.Count, file.Size)
		}
	}
	f.Add(make([]byte, cipherLen(0)), fuzzID, int64(0), int64(1), int64(0))
	f.Add(make([]byte, cipherLen(10)), fuzzID, int64(0), int64(1), int64(10))
	f.Add([]byte{}, "", int64(-1), int64(0), int64(-5))
	f.Add([]byte{1, 2, 3}, fuzzID, int64(1<<40), int64(1<<62), int64(1<<62))
	f.Fuzz(func(t *testing.T, blob []byte, itemID string, i, count, total int64) {
		out, err := decryptSegment(fuzzKey, itemID, i, count, total, blob)
		if err == nil && (int64(len(out)) > segPlain || int64(len(blob)) != cipherLen(int64(len(out)))) {
			t.Fatalf("decrypted %d bytes from a %d-byte segment", len(out), len(blob))
		}
	})
}

func FuzzWordsToKey(f *testing.F) {
	f.Add(strings.Repeat("abandon ", 23) + "art")
	f.Add("health opinion luxury act student tool property sing taxi sleep hamster envelope law loyal boost grocery this giraffe mansion reflect outdoor fly lobster hunt")
	f.Add("")
	f.Add(strings.Repeat("zzz ", 24))
	f.Fuzz(func(t *testing.T, input string) {
		k, err := wordsToKey(input)
		if err == nil && len(k) != 32 {
			t.Fatalf("key of %d bytes", len(k))
		}
	})
}

func FuzzSafeName(f *testing.F) {
	for _, s := range []string{"a/b\\c.jpg", "  .hidden  ", "", "..", "x\x1b[31m.png", strings.Repeat("n", 300) + ".jpeg", "\u202egpj.exe", "a" + strings.Repeat("é", 150) + ".jpg"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		n := safeName(in, "file")
		if n == "" || n == "." || n == ".." || strings.ContainsAny(n, "/\\\x00") || len(n) > 200 {
			t.Fatalf("safeName(%q) = %q", in, n)
		}
		if utf8.ValidString(in) && !utf8.ValidString(n) {
			t.Fatalf("safeName(%q) = %q: invalid UTF-8", in, n)
		}
	})
}
