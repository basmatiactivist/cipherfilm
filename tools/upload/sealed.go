package main

import (
	"crypto/subtle"
	"encoding/hex"
	"errors"

	"golang.org/x/crypto/curve25519"
	naclbox "golang.org/x/crypto/nacl/box"
)

// Item keys made by the phone's background backup are sealed to the account's public key instead of wrapped under
// the master key (web/src/crypto/item.ts): version(2) || crypto_box_seal(item key || item id as 16 bytes).
const sealedItemKeyLen = 1 + 48 + 48

// keyRing opens either kind of item key. The key pair comes from wrapped_privkey, opened with the master key; the
// public half is computed from the private one.
type keyRing struct {
	master, pk, sk []byte
}

func newKeyRing(master []byte, wrappedPrivkey, email string) *keyRing {
	k := &keyRing{master: master}
	if blob, err := b64.DecodeString(wrappedPrivkey); err == nil && wrappedPrivkey != "" {
		if sk, err := open(blob, master, "wrap/privkey", normEmail(email)); err == nil && len(sk) == 32 {
			if pk, err := curve25519.X25519(sk, curve25519.Basepoint); err == nil {
				k.pk, k.sk = pk, sk
			}
		}
	}
	return k
}

func (k *keyRing) itemKey(wrapped []byte, itemID string) ([]byte, error) {
	if len(wrapped) > 0 && wrapped[0] == 2 {
		if k.sk == nil {
			return nil, errors.New("the account key pair could not be opened")
		}
		return openSealedItemKey(wrapped, k.pk, k.sk, itemID)
	}
	return unwrapItemKey(wrapped, k.master, itemID)
}

func openSealedItemKey(blob, pk, sk []byte, itemID string) ([]byte, error) {
	id, err := hex.DecodeString(itemID)
	if len(blob) != sealedItemKeyLen || blob[0] != 2 || err != nil || len(id) != 16 {
		return nil, errors.New("unrecognised blob")
	}
	var pub, priv [32]byte
	copy(pub[:], pk)
	copy(priv[:], sk)
	pt, ok := naclbox.OpenAnonymous(nil, blob[1:], &pub, &priv)
	if !ok || len(pt) != 48 || subtle.ConstantTimeCompare(pt[32:], id) != 1 {
		return nil, errors.New("authentication failed")
	}
	return pt[:32], nil
}
