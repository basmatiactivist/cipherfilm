//go:build e2e

package main

// Helpers for the end-to-end test against a throwaway server (e2e/run.sh); never run against a real instance.
//   CF_URL, CF_CA, CF_EMAIL, CF_PASSWORD     the test server and account
//   CF_SETUP_TOKEN                           TestE2ECreateAccount: the setup token from the server's log
//   CF_EXPECT                                TestE2ECheckLibrary: how many items the library must hold

import (
	"bytes"
	"context"
	"encoding/json"
	"image/jpeg"
	"os"
	"strconv"
	"testing"

	"golang.org/x/crypto/curve25519"
)

func e2eClient(t *testing.T) *client {
	c, err := newClient(os.Getenv("CF_URL"), os.Getenv("CF_EMAIL"), os.Getenv("CF_CA"), 4)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (c *client) get(ctx context.Context, path string) ([]byte, error) {
	var b []byte
	err := c.do(ctx, "GET", path, nil, &b)
	return b, err
}

func TestE2ECreateAccount(t *testing.T) {
	email, password := normEmail(os.Getenv("CF_EMAIL")), os.Getenv("CF_PASSWORD")
	kdf := kdfParams{Alg: "argon2id13", V: 1, Ops: 3, Mem: 64 << 20, Salt: b64.EncodeToString(randBytes(16))}
	authKey, kek, err := deriveFromPassword(password, kdf)
	if err != nil {
		t.Fatal(err)
	}
	master, recovery, priv := randBytes(32), randBytes(32), randBytes(32)
	pub, _ := curve25519.X25519(priv, curve25519.Basepoint)
	body := map[string]any{
		"setup_token": os.Getenv("CF_SETUP_TOKEN"), "email": email, "kdf": kdf,
		"auth":                    b64.EncodeToString(authKey),
		"wrapped_master_pw":       b64.EncodeToString(seal(master, kek, "wrap/master/pw", email)),
		"wrapped_master_recovery": b64.EncodeToString(seal(master, kdfDerive(recovery, "RECWRAP1", 2), "wrap/master/recovery", email)),
		"wrapped_privkey":         b64.EncodeToString(seal(priv, master, "wrap/privkey", email)),
		"pubkey":                  b64.EncodeToString(pub),
		"recovery_verifier":       b64.EncodeToString(kdfDerive(recovery, "RECAUTH1", 1)),
	}
	if err := e2eClient(t).do(context.Background(), "POST", "/api/setup", body, nil); err != nil {
		t.Fatal(err)
	}
}

// TestE2ECheckLibrary signs in like the web app and checks every item's metadata, thumbnail and preview.
func TestE2ECheckLibrary(t *testing.T) {
	ctx := context.Background()
	c := e2eClient(t)
	master, _, err := c.login(ctx, os.Getenv("CF_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	var p listPage
	if err := c.do(ctx, "GET", "/api/items", nil, &p); err != nil {
		t.Fatal(err)
	}
	var raw struct {
		Items []struct {
			ID         string `json:"id"`
			Kind       string `json:"kind"`
			HasThumb   bool   `json:"has_thumb"`
			HasPreview bool   `json:"has_preview"`
		} `json:"items"`
	}
	if err := c.do(ctx, "GET", "/api/items", nil, &raw); err != nil {
		t.Fatal(err)
	}
	if want, _ := strconv.Atoi(os.Getenv("CF_EXPECT")); want != 0 && len(p.Items) != want {
		t.Fatalf("library holds %d items, want %d", len(p.Items), want)
	}
	for i, it := range p.Items {
		ik, err := unwrapItemKey(mustB64(t, it.WrappedItemKey), master, it.ID)
		if err != nil {
			t.Fatal(err)
		}
		mj, err := decryptMeta(mustB64(t, it.MetaEnc), ik, it.ID)
		if err != nil {
			t.Fatal(err)
		}
		var m itemMeta
		if err := json.Unmarshal(mj, &m); err != nil {
			t.Fatal(err)
		}
		line := string(mj)
		info := raw.Items[i]
		if m.Mime == "" || m.CaptureTS == 0 || m.LastModified == 0 {
			t.Errorf("%s: incomplete metadata %s", m.Name, line)
		}
		if !info.HasThumb || !info.HasPreview {
			t.Logf("%-28s %s  (no thumbnail)", m.Name, line)
			if info.Kind == "image" {
				t.Errorf("%s: an image without thumbnail", m.Name)
			}
			continue
		}
		dims := ""
		for _, k := range []struct {
			path, label, ctx string
			max              int
		}{{"thumb", "thumb", "ITEMTHMB", thumbPx}, {"preview", "preview", "ITEMPREV", previewPx}} {
			blob, err := c.get(ctx, "/api/items/"+it.ID+"/"+k.path)
			if err != nil {
				t.Fatal(err)
			}
			pt, err := open(blob, kdfDerive(ik, k.ctx, 0), k.label, it.ID)
			if err != nil {
				t.Fatalf("%s: %s: %v", m.Name, k.label, err)
			}
			cfg, err := jpeg.DecodeConfig(bytes.NewReader(pt))
			if err != nil || max(cfg.Width, cfg.Height) > k.max {
				t.Fatalf("%s: %s is not a JPEG of at most %d px: %v %+v", m.Name, k.label, k.max, err, cfg)
			}
			if (cfg.Width > cfg.Height) != (m.Width > m.Height) && m.Width != m.Height {
				t.Errorf("%s: %s is %dx%d but the photo is %dx%d (orientation?)", m.Name, k.label, cfg.Width, cfg.Height, m.Width, m.Height)
			}
			if k.label == "preview" && m.Make == "TestCam" {
				// samples.swift marks the top left corner white and stores the photo sideways (orientation 6):
				// shown upright, the mark is at the top right
				img, _ := jpeg.Decode(bytes.NewReader(pt))
				b := img.Bounds()
				white := func(x, y int) bool {
					r, g, bl, _ := img.At(x, y).RGBA()
					return r > 0xe000 && g > 0xe000 && bl > 0xe000
				}
				if !white(b.Dx()*97/100, b.Dy()/20) || white(b.Dx()/20, b.Dy()/20) {
					t.Errorf("%s: the preview is not turned upright", m.Name)
				}
			}
			dims += " " + k.label + "=" + strconv.Itoa(cfg.Width) + "x" + strconv.Itoa(cfg.Height)
		}
		t.Logf("%-28s %s %s", m.Name, line, dims)
	}
}
