package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"

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

// Sign-in and recovery from unknown browsers wait in a short queue: when it is full they are turned away at once,
// so a flood cannot build a backlog that every other sign-in waits behind. Known browsers are never turned away.
const maxArgonWaiting = 16

var argonWaiting atomic.Int32

var errBusy = errors.New("busy")

func argonKey(secret, salt []byte) []byte {
	argonSlots <- struct{}{}
	defer func() { <-argonSlots }()
	return argon2.IDKey(secret, salt, srvT, srvM, 1, 32)
}

// argonTurn waits for an Argon2 slot for a credential check, and gives up when the client has gone (the work would
// be for nobody) or, if capped, when too many are already waiting.
func argonTurn(ctx context.Context, capped bool) (release func(), err error) {
	if n := argonWaiting.Add(1); capped && n > maxArgonWaiting {
		argonWaiting.Add(-1)
		return nil, errBusy
	}
	defer argonWaiting.Add(-1)
	select {
	case argonSlots <- struct{}{}:
		return func() { <-argonSlots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
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
	good, _ := verifySecretCtx(context.Background(), false, stored, secretB64)
	return good
}

// verifySecretCtx is verifySecret for a request: err is set when no slot was had (see argonTurn), and nothing was
// checked.
func verifySecretCtx(ctx context.Context, capped bool, stored, secretB64 string) (bool, error) {
	secret, err := b64.DecodeString(secretB64)
	if err != nil || len(secret) != 32 {
		return false, nil
	}
	p := strings.SplitN(stored, "$", 2)
	if len(p) != 2 {
		return false, nil
	}
	salt, e1 := b64.DecodeString(p[0])
	want, e2 := b64.DecodeString(p[1])
	if e1 != nil || e2 != nil {
		return false, nil
	}
	release, err := argonTurn(ctx, capped)
	if err != nil {
		return false, err
	}
	defer release()
	got := argon2.IDKey(secret, salt, srvT, srvM, 1, 32)
	return subtle.ConstantTimeCompare(got, want) == 1, nil
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
