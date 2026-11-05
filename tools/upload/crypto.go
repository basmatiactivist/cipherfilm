package main

// The encrypting side of the Cipherfilm file format (docs/CRYPTO.md), ported from web/src/crypto (kdf.ts, account.ts,
// wrap.ts, item.ts, file.ts). Primitives and labels follow tools/decrypt/crypto.go: Argon2id, libsodium's BLAKE2b KDF,
// XChaCha20-Poly1305 and the secretstream construction, all in pure Go so the tool cross-compiles without cgo.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
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
	metaPad   = 256
	wrapNonce = 24

	tagMessage = 0
	tagFinal   = 3
)

var b64 = base64.RawURLEncoding

type kdfParams struct {
	Alg  string `json:"alg"`
	V    int    `json:"v"`
	Ops  int    `json:"ops"`
	Mem  int    `json:"mem"` // bytes
	Salt string `json:"salt"`
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
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

// deriveFromPassword is kdf.ts deriveFromPassword: Argon2id(32 B) of the NFKC password, split into the login proof and
// the key that wraps the master key.
// Lowest accepted Argon2id settings; variables only so unit tests can run quickly.
var minOps, minMem = 2, 32 << 20

func deriveFromPassword(password string, p kdfParams) (authKey, kek []byte, err error) {
	if p.Alg != "argon2id13" || p.V != 1 {
		return nil, nil, errors.New("the server uses password-hashing parameters this tool does not know")
	}
	salt, err := b64.DecodeString(p.Salt)
	if err != nil || len(salt) != 16 {
		return nil, nil, errors.New("the server sent a bad salt")
	}
	// the same bounds as the server, the web app and the Android app: a server can't talk the tool into cheap hashing
	// whose result (the login proof) it could then guess passwords against
	if p.Ops < minOps || p.Ops > 10 || p.Mem < minMem || p.Mem > 1<<30 {
		return nil, nil, errors.New("the server sent implausible password-hashing parameters")
	}
	root := argon2.IDKey([]byte(norm.NFKC.String(password)), salt, uint32(p.Ops), uint32(p.Mem/1024), 1, 32)
	authKey, kek = kdfDerive(root, "AUTHKEY1", 1), kdfDerive(root, "KEKWRAP1", 2)
	clear(root)
	return authKey, kek, nil
}

func adFor(label, owner string) []byte { return []byte(label + "\x00" + owner) }

// seal is wrap.ts seal: version(1) || nonce(24) || XChaCha20-Poly1305(plaintext, ad = label NUL owner).
func seal(plain, key []byte, label, owner string) []byte {
	return sealWithNonce(plain, key, label, owner, randBytes(wrapNonce))
}

func sealWithNonce(plain, key []byte, label, owner string, nonce []byte) []byte {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		panic(err)
	}
	out := make([]byte, 1+wrapNonce, 1+wrapNonce+len(plain)+aead.Overhead())
	out[0] = 1
	copy(out[1:], nonce)
	return aead.Seal(out, nonce, plain, adFor(label, owner))
}

func open(blob, key []byte, label, owner string) ([]byte, error) {
	if len(blob) < 1+wrapNonce+16 || blob[0] != 1 {
		return nil, errors.New("unrecognised blob")
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	pt, err := aead.Open(nil, blob[1:1+wrapNonce], blob[1+wrapNonce:], adFor(label, owner))
	if err != nil {
		return nil, errors.New("authentication failed")
	}
	return pt, nil
}

func unlockMasterKey(email string, kek, wrappedMasterPW []byte) ([]byte, error) {
	return open(wrappedMasterPW, kek, "wrap/master/pw", normEmail(email))
}

func wrapItemKey(itemKey, master []byte, itemID string) []byte {
	return seal(itemKey, master, "wrap/item", itemID)
}

func unwrapItemKey(wrapped, master []byte, itemID string) ([]byte, error) {
	return open(wrapped, master, "wrap/item", itemID)
}

// pad is libsodium's sodium_pad (ISO/IEC 7816-4): 0x80, then zeros up to a multiple of the block size.
func pad(b []byte, block int) []byte {
	n := len(b) + block - len(b)%block
	out := make([]byte, n)
	copy(out, b)
	out[len(b)] = 0x80
	return out
}

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

// encryptMeta seals the metadata JSON, padded to a multiple of 256 bytes, under the item's metadata subkey.
func encryptMeta(metaJSON, itemKey []byte, itemID string) []byte {
	return seal(pad(metaJSON, metaPad), kdfDerive(itemKey, "ITEMMETA", 0), "meta", itemID)
}

func decryptMeta(blob, itemKey []byte, itemID string) ([]byte, error) {
	padded, err := open(blob, kdfDerive(itemKey, "ITEMMETA", 0), "meta", itemID)
	if err != nil {
		return nil, err
	}
	return unpad(padded)
}

func encryptThumb(data, itemKey []byte, itemID string) []byte {
	return seal(data, kdfDerive(itemKey, "ITEMTHMB", 0), "thumb", itemID)
}

func encryptPreview(data, itemKey []byte, itemID string) []byte {
	return seal(data, kdfDerive(itemKey, "ITEMPREV", 0), "preview", itemID)
}

// ---- segments: libsodium crypto_secretstream_xchacha20poly1305, push side ----

func segmentCount(total int64) int64 {
	if total <= 0 {
		return 1
	}
	return (total + segPlain - 1) / segPlain
}

// segmentPlainLen is the plaintext length of segment i of a file of the given size.
func segmentPlainLen(total, i int64) int64 {
	return min(segPlain, total-i*segPlain)
}

func cipherLen(p int64) int64 {
	chunks := max(1, (p+chunkSize-1)/chunkSize)
	return ssHeader + p + chunks*ssABytes
}

// segAD binds the item, the segment index, the segment count and the total size into every chunk's tag.
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

func ssInit(key, header []byte) *ssState {
	k, err := chacha20.HChaCha20(key, header[:16])
	if err != nil {
		panic(err)
	}
	s := &ssState{k: k}
	s.nonce[0] = 1 // counter, little endian
	copy(s.nonce[4:], header[16:24])
	return s
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

// push appends one encrypted chunk (tag byte, ciphertext, MAC) to out, exactly like crypto_secretstream_xchacha20poly1305_push.
func (s *ssState) push(out, m, ad []byte, tag byte) []byte {
	block := make([]byte, 64)
	s.stream(0).XORKeyStream(block, block)
	var pk [32]byte
	copy(pk[:], block[:32])
	mac := poly1305.New(&pk)
	mac.Write(ad)
	mac.Write(pad16(len(ad)))
	tb := make([]byte, 64)
	tb[0] = tag
	s.stream(1).XORKeyStream(tb, tb)
	mac.Write(tb)
	start := len(out)
	out = append(out, tb[0])
	out = append(out, m...)
	c := out[start+1:]
	s.stream(2).XORKeyStream(c, c)
	mac.Write(c)
	mac.Write(make([]byte, len(m)&0xf)) // libsodium's (0x10 - 64 + mlen) & 0xf, see tools/decrypt/crypto.go
	var l [16]byte
	binary.LittleEndian.PutUint64(l[0:], uint64(len(ad)))
	binary.LittleEndian.PutUint64(l[8:], uint64(64+len(m)))
	mac.Write(l[:])
	sum := mac.Sum(nil)
	out = append(out, sum...)
	for i := 0; i < 8; i++ {
		s.nonce[4+i] ^= sum[i]
	}
	for i := 0; i < 4; i++ { // increment the 32-bit little-endian counter (it never wraps: a segment has at most 64 chunks)
		s.nonce[i]++
		if s.nonce[i] != 0 {
			break
		}
	}
	return out
}

// encryptSegment is file.ts encryptSegment: one segment as an independent secretstream of 64 KiB chunks.
func encryptSegment(itemKey []byte, itemID string, i, count, total int64, plain []byte) ([]byte, error) {
	return encryptSegmentWithHeader(itemKey, itemID, i, count, total, plain, randBytes(ssHeader))
}

func encryptSegmentWithHeader(itemKey []byte, itemID string, i, count, total int64, plain, header []byte) ([]byte, error) {
	if int64(len(plain)) != segmentPlainLen(total, i) && !(total == 0 && len(plain) == 0) {
		return nil, errors.New("unexpected segment length")
	}
	st := ssInit(kdfDerive(itemKey, "ITEMSEGM", uint64(i)), header)
	ad := segAD(itemID, i, count, total)
	out := make([]byte, 0, cipherLen(int64(len(plain))))
	out = append(out, header...)
	off := 0
	for {
		end := min(off+chunkSize, len(plain))
		var tag byte = tagMessage
		if end >= len(plain) {
			tag = tagFinal
		}
		out = st.push(out, plain[off:end], ad, tag)
		off = end
		if tag == tagFinal {
			break
		}
	}
	if int64(len(out)) != cipherLen(int64(len(plain))) {
		return nil, errors.New("internal size error")
	}
	return out, nil
}
