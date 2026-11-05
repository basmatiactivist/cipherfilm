package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// testdata/vectors.json was written by the app's own TypeScript crypto (web/src/crypto/vectors.gen.test.ts).
// Decrypting it here proves the two implementations agree byte for byte.
type vectors struct {
	Email, Password       string
	KDF                   kdfParams `json:"kdf"`
	RecoveryWords         string    `json:"recovery_words"`
	WrappedMasterPW       string    `json:"wrapped_master_pw"`
	WrappedMasterRecovery string    `json:"wrapped_master_recovery"`
	WrappedPrivkey        string    `json:"wrapped_privkey"`
	Sealed                struct {
		ID, Name       string
		Size           int64
		WrappedItemKey string `json:"wrapped_item_key"`
		MetaEnc        string `json:"meta_enc"`
	}
	Album struct {
		ID, Name string
		NameEnc  string `json:"name_enc"`
	}
	Files []struct {
		ID             string
		Size           int64
		Count          int64
		WrappedItemKey string `json:"wrapped_item_key"`
		MetaEnc        string `json:"meta_enc"`
		Segment0       string
		SHA256, Name   string
	}
}

func load(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func masterViaPassword(t *testing.T, v vectors, pw string) ([]byte, error) {
	kek, err := passwordKEK(pw, v.KDF)
	if err != nil {
		t.Fatal(err)
	}
	return open(mustB64(v.WrappedMasterPW), kek, "wrap/master/pw", normEmail(v.Email))
}

func TestUnlockWithPasswordAndRecoveryKey(t *testing.T) {
	v := load(t)
	m1, err := masterViaPassword(t, v, v.Password)
	if err != nil {
		t.Fatalf("password unlock: %v", err)
	}
	rk, err := wordsToKey(v.RecoveryWords)
	if err != nil {
		t.Fatalf("recovery words: %v", err)
	}
	m2, err := open(mustB64(v.WrappedMasterRecovery), recoveryWrapKey(rk), "wrap/master/recovery", normEmail(v.Email))
	if err != nil {
		t.Fatalf("recovery unlock: %v", err)
	}
	if hex.EncodeToString(m1) != hex.EncodeToString(m2) {
		t.Fatal("password and recovery key unlock different master keys")
	}
	if _, err := masterViaPassword(t, v, v.Password+"x"); err == nil {
		t.Fatal("wrong password accepted")
	}
}

func TestRecoveryWordsRejectTyposAndBadLength(t *testing.T) {
	v := load(t)
	if _, err := wordsToKey("abandon abandon"); err == nil {
		t.Fatal("short input accepted")
	}
	if _, err := wordsToKey(v.RecoveryWords + " extra"); err == nil {
		t.Fatal("25 words accepted")
	}
}

func TestAlbumNamesItemsAndFilesMatchTheApp(t *testing.T) {
	v := load(t)
	master, err := masterViaPassword(t, v, v.Password)
	if err != nil {
		t.Fatal(err)
	}
	name, err := decryptAlbumName(mustB64(v.Album.NameEnc), master, v.Album.ID)
	if err != nil || name != v.Album.Name {
		t.Fatalf("album name %q err %v", name, err)
	}
	if _, err := decryptAlbumName(mustB64(v.Album.NameEnc), master, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"); err == nil {
		t.Fatal("album name accepted under another album id")
	}
	other := "ffffffffffffffffffffffffffffffff"
	for _, f := range v.Files {
		ik, err := unwrapItemKey(mustB64(f.WrappedItemKey), master, f.ID)
		if err != nil {
			t.Fatalf("%s: item key: %v", f.Name, err)
		}
		if _, err := unwrapItemKey(mustB64(f.WrappedItemKey), master, other); err == nil {
			t.Fatalf("%s: item key accepted for another item id", f.Name)
		}
		raw, err := decryptMeta(mustB64(f.MetaEnc), ik, f.ID)
		if err != nil {
			t.Fatalf("%s: meta: %v", f.Name, err)
		}
		var m meta
		json.Unmarshal(raw, &m)
		if m.Name != f.Name || m.Size != f.Size {
			t.Fatalf("%s: meta %+v", f.Name, m)
		}
		blob := mustB64(f.Segment0)
		plain, err := decryptSegment(ik, f.ID, 0, f.Count, f.Size, blob)
		if err != nil {
			t.Fatalf("%s: segment: %v", f.Name, err)
		}
		sum := sha256.Sum256(plain)
		if hex.EncodeToString(sum[:]) != f.SHA256 {
			t.Fatalf("%s: content differs from what the app encrypted", f.Name)
		}
		// any change must be detected: flipped bit, wrong item id, wrong total size, truncation
		flipped := append([]byte{}, blob...)
		flipped[len(flipped)/2] ^= 1
		checks := map[string]func() error{
			"flipped bit": func() error { _, e := decryptSegment(ik, f.ID, 0, f.Count, f.Size, flipped); return e },
			"other item":  func() error { _, e := decryptSegment(ik, other, 0, f.Count, f.Size, blob); return e },
			"other size":  func() error { _, e := decryptSegment(ik, f.ID, 0, f.Count, f.Size+1, blob); return e },
			"truncated":   func() error { _, e := decryptSegment(ik, f.ID, 0, f.Count, f.Size, blob[:len(blob)-1]); return e },
		}
		for label, check := range checks {
			if check() == nil {
				t.Fatalf("%s: %s not detected", f.Name, label)
			}
		}
	}
}

func TestSafeName(t *testing.T) {
	cases := map[string]string{"a/b\\c.jpg": "a_b_c.jpg", "  .hidden  ": "hidden", "": "FALLBACK", "..": "FALLBACK", "ok.png": "ok.png"}
	for in, want := range cases {
		if got := safeName(in, "FALLBACK"); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestItemKeySealedByTheBackupOpensWithTheAccountKeyPair(t *testing.T) {
	v := load(t)
	master, err := masterViaPassword(t, v, v.Password)
	if err != nil {
		t.Fatal(err)
	}
	keys := newKeyRing(master, v.WrappedPrivkey, v.Email)
	ik, err := keys.itemKey(mustB64(v.Sealed.WrappedItemKey), v.Sealed.ID)
	if err != nil {
		t.Fatalf("sealed item key: %v", err)
	}
	raw, err := decryptMeta(mustB64(v.Sealed.MetaEnc), ik, v.Sealed.ID)
	if err != nil {
		t.Fatalf("meta: %v", err)
	}
	var m meta
	json.Unmarshal(raw, &m)
	if m.Name != v.Sealed.Name {
		t.Fatalf("meta %+v", m)
	}
	if _, err := keys.itemKey(mustB64(v.Sealed.WrappedItemKey), "ffffffffffffffffffffffffffffffff"); err == nil {
		t.Fatal("sealed key accepted for another item id")
	}
	if _, err := newKeyRing(master, "", v.Email).itemKey(mustB64(v.Sealed.WrappedItemKey), v.Sealed.ID); err == nil {
		t.Fatal("sealed key opened without the key pair")
	}
	// the ordinary keys still open through the same ring
	if _, err := keys.itemKey(mustB64(v.Files[0].WrappedItemKey), v.Files[0].ID); err != nil {
		t.Fatalf("wrapped key: %v", err)
	}
}
