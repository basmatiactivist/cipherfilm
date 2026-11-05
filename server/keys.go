package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Server-side hash of the client-derived auth key (the "second hash").
const (
	srvT = 2
	srvM = 32 * 1024 // KiB
)

// argonSlots bounds concurrent server-side Argon2 work (32 MiB each) so a burst of anonymous requests cannot
// multiply memory past the container limit; excess requests wait for a slot.
var argonSlots = make(chan struct{}, 4)

func argonKey(secret, salt []byte) []byte {
	argonSlots <- struct{}{}
	defer func() { <-argonSlots }()
	return argon2.IDKey(secret, salt, srvT, srvM, 1, 32)
}

func hashSecret(secretB64 string) (string, error) {
	secret, err := b64.DecodeString(secretB64)
	if err != nil || len(secret) != 32 {
		return "", errors.New("bad secret")
	}
	salt := randBytes(16)
	h := argonKey(secret, salt)
	return b64.EncodeToString(salt) + "$" + b64.EncodeToString(h), nil
}

func verifySecret(stored, secretB64 string) bool {
	secret, err := b64.DecodeString(secretB64)
	if err != nil || len(secret) != 32 {
		return false
	}
	p := strings.SplitN(stored, "$", 2)
	if len(p) != 2 {
		return false
	}
	salt, e1 := b64.DecodeString(p[0])
	want, e2 := b64.DecodeString(p[1])
	if e1 != nil || e2 != nil {
		return false
	}
	got := argonKey(secret, salt)
	return subtle.ConstantTimeCompare(got, want) == 1
}

type kdfParams struct {
	Alg  string `json:"alg"`
	V    int    `json:"v"`
	Ops  uint32 `json:"ops"`
	Mem  uint32 `json:"mem"` // bytes
	Salt string `json:"salt"`
}

// Floors/ceilings so a buggy or hostile client cannot store trivially weak params
// (and a hostile one can't make future logins cost gigabytes).
const (
	minOps, maxOps = 2, 10
	minMem, maxMem = 32 << 20, 1 << 30
	wrappedLen     = 1 + 24 + 32 + 16
	// an item key sealed to the account's public key by the phone's background backup (web/src/crypto/item.ts)
	sealedItemKeyLen = 1 + 48 + 48
)

func (k kdfParams) validate() error {
	if k.Alg != "argon2id13" || k.V != 1 {
		return errors.New("unsupported kdf")
	}
	if k.Ops < minOps || k.Ops > maxOps || k.Mem < minMem || k.Mem > maxMem {
		return errors.New("kdf parameters out of range")
	}
	return checkLen(k.Salt, 16)
}

func checkLen(s string, n int) error {
	b, err := b64.DecodeString(s)
	if err != nil || len(b) != n {
		return errors.New("bad field")
	}
	return nil
}

type keyBundle struct {
	KDF                   kdfParams `json:"kdf"`
	Auth                  string    `json:"auth"`
	WrappedMasterPW       string    `json:"wrapped_master_pw"`
	WrappedMasterRecovery string    `json:"wrapped_master_recovery"`
	WrappedPrivkey        string    `json:"wrapped_privkey"`
	Pubkey                string    `json:"pubkey"`
	RecoveryVerifier      string    `json:"recovery_verifier"`
}

func (b keyBundle) validate() error {
	if err := b.KDF.validate(); err != nil {
		return err
	}
	for _, f := range []struct {
		v string
		n int
	}{
		{b.Auth, 32}, {b.Pubkey, 32}, {b.RecoveryVerifier, 32},
		{b.WrappedMasterPW, wrappedLen}, {b.WrappedMasterRecovery, wrappedLen}, {b.WrappedPrivkey, wrappedLen},
	} {
		if err := checkLen(f.v, f.n); err != nil {
			return err
		}
	}
	return nil
}

func (k kdfParams) json() string {
	b, _ := json.Marshal(k)
	return string(b)
}
