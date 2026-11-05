package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"golang.org/x/crypto/poly1305"
)

// ---- the decrypt side, as in tools/decrypt/crypto.go (kept separate on purpose: it checks the code above) ----

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
	mac.Write(adPad(ad))
	mac.Write(tb)
	mac.Write(c[1 : 1+mlen])
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
	for i := 0; i < 4; i++ {
		s.nonce[i]++
		if s.nonce[i] != 0 {
			break
		}
	}
	return msg, tag, nil
}

func adPad(ad []byte) []byte { return append(append([]byte{}, ad...), pad16(len(ad))...) }

func decryptSegment(itemKey []byte, itemID string, i, count, total int64, blob []byte) ([]byte, error) {
	want := min(total-i*segPlain, segPlain)
	if total == 0 {
		want = 0
	}
	if i < 0 || i >= count || count != segmentCount(total) || want < 0 || int64(len(blob)) != cipherLen(want) {
		return nil, errors.New("segment failed verification")
	}
	st := ssInit(kdfDerive(itemKey, "ITEMSEGM", uint64(i)), blob[:ssHeader])
	ad := segAD(itemID, i, count, total)
	out := make([]byte, 0, want)
	o := int64(ssHeader)
	for {
		end := min(o+chunkSize+ssABytes, int64(len(blob)))
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

// ---- vectors written by the web app's own crypto (tools/decrypt/testdata/vectors.json) ----

type vectors struct {
	Email, Password string
	KDF             kdfParams `json:"kdf"`
	WrappedMasterPW string    `json:"wrapped_master_pw"`
	Files           []struct {
		ID             string
		Size           int64
		Count          int64
		WrappedItemKey string `json:"wrapped_item_key"`
		MetaEnc        string `json:"meta_enc"`
		Segment0       string
		SHA256, Name   string
	}
}

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := b64.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func loadVectors(t *testing.T) vectors {
	raw, err := os.ReadFile("../decrypt/testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// Re-encrypting what the web app encrypted, with the same random header and nonces, must give the same bytes:
// then this tool writes exactly the app's format.
func TestEncryptionMatchesTheWebAppByteForByte(t *testing.T) {
	v := loadVectors(t)
	_, kek, err := deriveFromPassword(v.Password, v.KDF)
	if err != nil {
		t.Fatal(err)
	}
	master, err := unlockMasterKey(v.Email, kek, mustB64(t, v.WrappedMasterPW))
	if err != nil {
		t.Fatalf("password unlock: %v", err)
	}
	if _, kek2, _ := deriveFromPassword(v.Password+"x", v.KDF); func() bool { _, e := unlockMasterKey(v.Email, kek2, mustB64(t, v.WrappedMasterPW)); return e == nil }() {
		t.Fatal("wrong password unlocked the master key")
	}
	for _, f := range v.Files {
		wk := mustB64(t, f.WrappedItemKey)
		ik, err := unwrapItemKey(wk, master, f.ID)
		if err != nil {
			t.Fatalf("%s: item key: %v", f.Name, err)
		}
		if got := sealWithNonce(ik, master, "wrap/item", f.ID, wk[1:25]); !bytes.Equal(got, wk) {
			t.Fatalf("%s: item key wrap differs from the app's", f.Name)
		}
		me := mustB64(t, f.MetaEnc)
		metaJSON, err := decryptMeta(me, ik, f.ID)
		if err != nil {
			t.Fatalf("%s: meta: %v", f.Name, err)
		}
		if got := sealWithNonce(pad(metaJSON, metaPad), kdfDerive(ik, "ITEMMETA", 0), "meta", f.ID, me[1:25]); !bytes.Equal(got, me) {
			t.Fatalf("%s: metadata (padding or seal) differs from the app's", f.Name)
		}
		seg := mustB64(t, f.Segment0)
		plain, err := decryptSegment(ik, f.ID, 0, f.Count, f.Size, seg)
		if err != nil {
			t.Fatalf("%s: segment: %v", f.Name, err)
		}
		if sum := sha256.Sum256(plain); hex.EncodeToString(sum[:]) != f.SHA256 {
			t.Fatalf("%s: content differs", f.Name)
		}
		again, err := encryptSegmentWithHeader(ik, f.ID, 0, f.Count, f.Size, plain, seg[:ssHeader])
		if err != nil || !bytes.Equal(again, seg) {
			t.Fatalf("%s: segment encryption differs from the app's (err %v)", f.Name, err)
		}
	}
}

func TestSegmentsRoundTrip(t *testing.T) {
	key := randBytes(32)
	id := "00112233445566778899aabbccddeeff"
	for _, size := range []int64{0, 1, chunkSize - 1, chunkSize, chunkSize + 1, segPlain - 1, segPlain, segPlain + 1, 2*segPlain + 12345} {
		data := randBytes(int(size))
		count := segmentCount(size)
		var back []byte
		for i := int64(0); i < count; i++ {
			l := int64(0)
			if size > 0 {
				l = segmentPlainLen(size, i)
			}
			ct, err := encryptSegment(key, id, i, count, size, data[i*segPlain:i*segPlain+l])
			if err != nil {
				t.Fatalf("size %d seg %d: %v", size, i, err)
			}
			if int64(len(ct)) != cipherLen(l) {
				t.Fatalf("size %d seg %d: length %d, want %d", size, i, len(ct), cipherLen(l))
			}
			pt, err := decryptSegment(key, id, i, count, size, ct)
			if err != nil {
				t.Fatalf("size %d seg %d: decrypt: %v", size, i, err)
			}
			back = append(back, pt...)
			ct[len(ct)/2] ^= 1
			if _, err := decryptSegment(key, id, i, count, size, ct); err == nil {
				t.Fatalf("size %d seg %d: flipped bit not detected", size, i)
			}
		}
		if !bytes.Equal(back, data) {
			t.Fatalf("size %d: round trip differs", size)
		}
	}
	if _, err := encryptSegment(key, id, 0, 1, 10, make([]byte, 9)); err == nil {
		t.Fatal("wrong segment length accepted")
	}
}

func TestMetaAndThumbsRoundTrip(t *testing.T) {
	ik := randBytes(32)
	id := "ffeeddccbbaa99887766554433221100"
	m := itemMeta{Name: "IMG_0001.HEIC", Mime: "image/heic", Size: 123, LastModified: 1, CaptureTS: 2, Width: 4032, Height: 3024, GPS: &gpsMeta{47.37, 8.54}}
	j, _ := json.Marshal(m)
	blob := encryptMeta(j, ik, id)
	if (len(blob)-1-24-16)%metaPad != 0 {
		t.Fatalf("metadata not padded to %d bytes: %d", metaPad, len(blob))
	}
	back, err := decryptMeta(blob, ik, id)
	if err != nil || !bytes.Equal(back, j) {
		t.Fatalf("meta round trip: %v", err)
	}
	if _, err := decryptMeta(blob, ik, "ffeeddccbbaa99887766554433221101"); err == nil {
		t.Fatal("metadata accepted under another item id")
	}
	if pt, err := open(encryptThumb([]byte("jpeg"), ik, id), kdfDerive(ik, "ITEMTHMB", 0), "thumb", id); err != nil || string(pt) != "jpeg" {
		t.Fatal("thumbnail round trip")
	}
	if pt, err := open(encryptPreview([]byte("jpeg"), ik, id), kdfDerive(ik, "ITEMPREV", 0), "preview", id); err != nil || string(pt) != "jpeg" {
		t.Fatal("preview round trip")
	}
}
