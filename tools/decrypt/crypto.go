package main

// Independent implementation of the Cipherfilm file format (see docs/CRYPTO.md). It uses only standard
// primitives (Argon2id, BLAKE2b KDF, XChaCha20-Poly1305, libsodium's secretstream construction) and shares no code
// with the app, so a backup stays readable even when the app, its server and its container are gone.

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"github.com/dchest/blake2b"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/poly1305"
	"golang.org/x/text/unicode/norm"
)

const (
	segPlain  = 4 * 1024 * 1024
	chunkSize = 64 * 1024
	ssHeader  = 24
	ssABytes  = 17
)

var b64 = base64.RawURLEncoding

type kdfParams struct {
	Alg  string `json:"alg"`
	V    int    `json:"v"`
	Ops  int    `json:"ops"`
	Mem  int    `json:"mem"` // bytes
	Salt string `json:"salt"`
}

// kdfDerive is libsodium's crypto_kdf_derive_from_key: keyed BLAKE2b with the subkey id as salt and the context as personalisation.
func kdfDerive(key []byte, ctx string, id uint64) []byte {
	salt := make([]byte, 16)
	binary.LittleEndian.PutUint64(salt, id)
	person := make([]byte, 16)
	copy(person, ctx)
	h, err := blake2b.New(&blake2b.Config{Size: 32, Key: key, Salt: salt, Person: person})
	if err != nil {
		panic(err)
	}
	return h.Sum(nil)
}

func normEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

// passwordKEK stretches the password exactly like the app and returns the key that wraps the master key.
func passwordKEK(password string, p kdfParams) ([]byte, error) {
	if p.Alg != "argon2id13" || p.V != 1 {
		return nil, errors.New("unsupported password-hashing parameters in this backup")
	}
	salt, err := b64.DecodeString(p.Salt)
	if err != nil || len(salt) != 16 {
		return nil, errors.New("bad salt in the backup")
	}
	if p.Ops < 1 || p.Ops > 10 || p.Mem < 8*1024 || p.Mem > 1<<30 { // the app itself only accepts ops 2-10 and 32 MiB-1 GiB
		return nil, errors.New("implausible password-hashing parameters in this backup")
	}
	root := argon2.IDKey([]byte(norm.NFKC.String(password)), salt, uint32(p.Ops), uint32(p.Mem/1024), 1, 32)
	return kdfDerive(root, "KEKWRAP1", 2), nil
}

func recoveryWrapKey(recoveryKey []byte) []byte { return kdfDerive(recoveryKey, "RECWRAP1", 2) }

func adFor(label, owner string) []byte { return []byte(label + "\x00" + owner) }

// open reverses the app's "wrapped" format: version(1) || nonce(24) || XChaCha20-Poly1305(ad = label NUL owner).
func open(blob, key []byte, label, owner string) ([]byte, error) {
	if len(blob) < 1+24+16 || blob[0] != 1 {
		return nil, errors.New("unrecognised blob")
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	pt, err := aead.Open(nil, blob[1:25], blob[25:], adFor(label, owner))
	if err != nil {
		return nil, errors.New("authentication failed")
	}
	return pt, nil
}

func unb64(s string) ([]byte, error) { return b64.DecodeString(s) }

func unpad(b []byte) ([]byte, error) {
	i := len(b) - 1
	for i >= 0 && b[i] == 0 {
		i--
	}
	if i < 0 || b[i] != 0x80 {
		return nil, errors.New("bad padding")
	}
	return b[:i], nil
}

func unwrapItemKey(wrapped, master []byte, itemID string) ([]byte, error) {
	return open(wrapped, master, "wrap/item", itemID)
}

func decryptMeta(blob, itemKey []byte, itemID string) ([]byte, error) {
	padded, err := open(blob, kdfDerive(itemKey, "ITEMMETA", 0), "meta", itemID)
	if err != nil {
		return nil, err
	}
	return unpad(padded)
}

func decryptAlbumName(blob, master []byte, albumID string) (string, error) {
	padded, err := open(blob, kdfDerive(master, "ALBUMNAM", 0), "album/name", albumID)
	if err != nil {
		return "", err
	}
	n, err := unpad(padded)
	return string(n), err
}

// ---- recovery key words ----

func wordsToKey(input string) ([]byte, error) {
	words := strings.Fields(strings.ToLower(input))
	if len(words) != 24 {
		return nil, errors.New("a recovery key has 24 words")
	}
	index := map[string]int{}
	for i, w := range wordlist {
		index[w] = i
	}
	data := make([]byte, 33)
	for i, w := range words {
		v, ok := index[w]
		if !ok {
			return nil, fmt.Errorf("unknown word: %s", w)
		}
		for b := 0; b < 11; b++ {
			if (v>>(10-b))&1 == 1 {
				bit := i*11 + b
				data[bit>>3] |= 1 << (7 - (bit & 7))
			}
		}
	}
	sum := sha256.Sum256(data[:32])
	if sum[0] != data[32] {
		return nil, errors.New("checksum mismatch: check the words for typos")
	}
	return data[:32], nil
}

// ---- secretstream (libsodium crypto_secretstream_xchacha20poly1305), decrypt side ----

func segmentCount(total int64) int64 {
	if total <= 0 {
		return 1
	}
	return (total + segPlain - 1) / segPlain
}

func cipherLen(p int64) int64 {
	chunks := (p + chunkSize - 1) / chunkSize
	if chunks < 1 {
		chunks = 1
	}
	return ssHeader + p + chunks*ssABytes
}

func segAD(itemID string, i, count, total int64) []byte {
	ad := []byte("seg\x00" + itemID)
	var t [16]byte
	binary.BigEndian.PutUint32(t[0:], uint32(i))
	binary.BigEndian.PutUint32(t[4:], uint32(count))
	binary.BigEndian.PutUint64(t[8:], uint64(total))
	return append(ad, t[:]...)
}

type ssState struct {
	k     []byte
	nonce [12]byte
}

func ssInitPull(key, header []byte) (*ssState, error) {
	k, err := chacha20.HChaCha20(key, header[:16])
	if err != nil {
		return nil, err
	}
	s := &ssState{k: k}
	s.nonce[0] = 1 // counter, little endian
	copy(s.nonce[4:], header[16:24])
	return s, nil
}

func (s *ssState) stream(counter uint32) *chacha20.Cipher {
	c, err := chacha20.NewUnauthenticatedCipher(s.k, s.nonce[:])
	if err != nil {
		panic(err)
	}
	c.SetCounter(counter)
	return c
}

func pad16(n int) []byte { return make([]byte, (16-n%16)%16) }

func (s *ssState) pull(c, ad []byte) (msg []byte, tag byte, err error) {
	if len(c) < ssABytes {
		return nil, 0, errors.New("chunk too short")
	}
	mlen := len(c) - ssABytes
	block := make([]byte, 64)
	s.stream(0).XORKeyStream(block, block)
	var pk [32]byte
	copy(pk[:], block[:32])
	tb := make([]byte, 64)
	tb[0] = c[0]
	s.stream(1).XORKeyStream(tb, tb)
	tag = tb[0]
	tb[0] = c[0]
	mac := poly1305.New(&pk)
	mac.Write(ad)
	mac.Write(pad16(len(ad)))
	mac.Write(tb)
	mac.Write(c[1 : 1+mlen])
	// libsodium pads with (0x10 - 64 + mlen) & 0xf zero bytes, which equals mlen & 0xf. It is not the usual
	// "round up to 16" rule, and it is part of the format, so it has to be copied exactly.
	mac.Write(make([]byte, mlen&0xf))
	var l [16]byte
	binary.LittleEndian.PutUint64(l[0:], uint64(len(ad)))
	binary.LittleEndian.PutUint64(l[8:], uint64(64+mlen))
	mac.Write(l[:])
	sum := mac.Sum(nil)
	if subtle.ConstantTimeCompare(sum, c[1+mlen:]) != 1 {
		return nil, 0, errors.New("authentication failed")
	}
	msg = make([]byte, mlen)
	s.stream(2).XORKeyStream(msg, c[1:1+mlen])
	for i := 0; i < 8; i++ {
		s.nonce[4+i] ^= sum[i]
	}
	for i := 0; i < 4; i++ { // increment the 32-bit little-endian counter
		s.nonce[i]++
		if s.nonce[i] != 0 {
			break
		}
	}
	return msg, tag, nil
}

const tagFinal = 3

// decryptSegment verifies and decrypts one 4 MiB segment of a file. total is the plaintext size of the whole file.
func decryptSegment(itemKey []byte, itemID string, i, count, total int64, blob []byte) ([]byte, error) {
	want := total - i*segPlain
	if want > segPlain {
		want = segPlain
	}
	if total == 0 {
		want = 0
	}
	if i < 0 || i >= count || count != segmentCount(total) || want < 0 || int64(len(blob)) != cipherLen(want) {
		return nil, errors.New("segment failed verification")
	}
	st, err := ssInitPull(kdfDerive(itemKey, "ITEMSEGM", uint64(i)), blob[:ssHeader])
	if err != nil {
		return nil, err
	}
	ad := segAD(itemID, i, count, total)
	out := make([]byte, 0, want)
	o := int64(ssHeader)
	for {
		end := o + chunkSize + ssABytes
		if end > int64(len(blob)) {
			end = int64(len(blob))
		}
		m, tag, err := st.pull(blob[o:end], ad)
		if err != nil {
			return nil, errors.New("segment failed verification")
		}
		out = append(out, m...)
		o = end
		if tag == tagFinal {
			break
		}
		if o >= int64(len(blob)) {
			return nil, errors.New("segment truncated")
		}
	}
	if o != int64(len(blob)) || int64(len(out)) != want {
		return nil, errors.New("segment failed verification")
	}
	return out, nil
}
