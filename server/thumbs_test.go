package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func (c *client) postRaw(path string, body any) (int, []byte) {
	c.e.t.Helper()
	j, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", c.e.srv.URL+path, bytes.NewReader(j))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", c.csrf)
	resp, err := c.c.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func TestThumbBatch(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	a := e.newItem(admin, 10)
	b := e.newItem(admin, 10)
	ta, tb := randBytes(700), randBytes(300)
	admin.put("/api/items/"+a+"/thumb", ta)
	admin.put("/api/items/"+b+"/thumb", tb)
	noThumb := e.newItem(admin, 10)
	// someone else's item is not served
	other, _ := e.acceptInvite(e.invite(admin, "o@x.org"))
	theirs := e.newItem(other, 10)
	other.put("/api/items/"+theirs+"/thumb", randBytes(100))

	code, body := admin.postRaw("/api/items/thumbs", map[string]any{"item_ids": []string{b, theirs, a, noThumb}})
	if code != 200 {
		t.Fatalf("batch: %d", code)
	}
	r := bytes.NewReader(body)
	next := func() []byte {
		var n uint32
		if binary.Read(r, binary.BigEndian, &n) != nil {
			t.Fatal("short response")
		}
		if n == 0xFFFFFFFF {
			return nil
		}
		out := make([]byte, n)
		io.ReadFull(r, out)
		return out
	}
	if got := next(); !bytes.Equal(got, tb) {
		t.Fatal("first thumbnail")
	}
	if next() != nil {
		t.Fatal("another person's thumbnail was served")
	}
	if got := next(); !bytes.Equal(got, ta) {
		t.Fatal("third thumbnail")
	}
	if next() != nil || r.Len() != 0 {
		t.Fatal("missing thumbnail or trailing bytes")
	}
	// limits and bad ids
	many := make([]string, thumbBatch+1)
	for i := range many {
		many[i] = a
	}
	if code, _ := admin.postRaw("/api/items/thumbs", map[string]any{"item_ids": many}); code != 400 {
		t.Fatalf("too many: %d", code)
	}
	if code, _ := admin.postRaw("/api/items/thumbs", map[string]any{"item_ids": []string{"../etc"}}); code != 400 {
		t.Fatalf("bad id: %d", code)
	}
	// signed out
	anon := e.client()
	if code, _ := anon.postRaw("/api/items/thumbs", map[string]any{"item_ids": []string{a}}); code != 401 && code != 403 {
		t.Fatalf("anonymous: %d", code)
	}
}
