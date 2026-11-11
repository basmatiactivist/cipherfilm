package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type uploader struct {
	c        *client
	master   []byte
	st       *state
	segments int // parts of one file in flight
	tmp      string
	allowDup bool
	log      io.Writer
	tty      bool // log is a terminal: messages first clear the progress line

	dupMu sync.Mutex
	dups  map[string]bool // name NUL size NUL capture_ts of everything in the library (and claimed in this run)

	stats stats
}

type stats struct {
	total, done, skipped, dup, failed atomic.Int64
	bytesTotal, bytesDone             atomic.Int64 // plaintext bytes of the files still to upload in this run
}

func dupKey(name string, size, capture int64) string {
	return name + "\x00" + strconv.FormatInt(size, 10) + "\x00" + strconv.FormatInt(capture, 10)
}

type listPage struct {
	Items []struct {
		ID             string `json:"id"`
		WrappedItemKey string `json:"wrapped_item_key"`
		MetaEnc        string `json:"meta_enc"`
	} `json:"items"`
	Next      string `json:"next"`
	QuotaLeft int64  `json:"quota_left"`
	Unlimited bool   `json:"unlimited"`
}

// loadLibrary decrypts the metadata of every item already on the server, for the duplicate check.
func (u *uploader) loadLibrary(ctx context.Context) (n int, quotaLeft int64, unlimited bool, err error) {
	u.dups = map[string]bool{}
	keys := newKeyRing(u.master, u.c.wrappedPrivkey, u.c.email) // also opens items from the phone's background backup
	path := "/api/items"
	first := true
	for {
		var p listPage
		if err := u.c.do(ctx, "GET", path, nil, &p); err != nil {
			return n, 0, false, err
		}
		if first {
			quotaLeft, unlimited, first = p.QuotaLeft, p.Unlimited, false
		}
		for _, it := range p.Items {
			wk, err1 := b64.DecodeString(it.WrappedItemKey)
			me, err2 := b64.DecodeString(it.MetaEnc)
			if err1 != nil || err2 != nil {
				continue
			}
			ik, err := keys.itemKey(wk, it.ID)
			if err != nil {
				continue
			}
			raw, err := decryptMeta(me, ik, it.ID)
			if err != nil {
				continue
			}
			var m itemMeta
			if json.Unmarshal(raw, &m) == nil {
				u.dups[dupKey(m.Name, m.Size, m.CaptureTS)] = true
				n++
			}
		}
		if p.Next == "" {
			return n, quotaLeft, unlimited, nil
		}
		path = "/api/items?after=" + url.QueryEscape(p.Next)
	}
}

// claim reports whether the file is new, and if so reserves its key so a copy elsewhere in the folder is not
// uploaded twice in the same run.
func (u *uploader) claim(info *fileInfo) (key string, isNew bool) {
	u.dupMu.Lock()
	defer u.dupMu.Unlock()
	m := info.Meta
	for _, ts := range append([]int64{m.CaptureTS}, info.altCapture...) {
		if u.dups[dupKey(m.Name, m.Size, ts)] {
			return "", false
		}
	}
	key = dupKey(m.Name, m.Size, m.CaptureTS)
	u.dups[key] = true
	return key, true
}

func (u *uploader) unclaim(key string) {
	u.dupMu.Lock()
	delete(u.dups, key)
	u.dupMu.Unlock()
}

// idRe is the item id format of the server. An id is bound into the item key and used in paths later, so the uploader
// refuses to wrap a key for anything else.
var idRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

type uploadState struct {
	State    string  `json:"state"`
	Size     int64   `json:"size"`
	Count    int64   `json:"segment_count"`
	Received []int64 `json:"received"`
	HasThumb bool    `json:"has_thumb"`
	HasPrev  bool    `json:"has_preview"`
}

// uploadOne encrypts and uploads one file; safe to repeat after an interruption.
func (u *uploader) uploadOne(ctx context.Context, f *localFile) (err error) {
	key := f.key()
	if e, ok := u.st.get(key); ok && e.Done {
		u.stats.skipped.Add(1)
		u.stats.bytesTotal.Add(-f.Size)
		return nil
	}
	info := readInfo(f)
	resume, hasResume := u.st.get(key)
	if !u.allowDup && !hasResume {
		claimed, isNew := u.claim(info)
		if !isNew {
			u.stats.dup.Add(1)
			u.stats.bytesTotal.Add(-f.Size)
			return nil
		}
		defer func() {
			if err != nil {
				u.unclaim(claimed) // let a copy elsewhere in the folder try instead
			}
		}()
	}
	count := segmentCount(f.Size)
	var id string
	var itemKey []byte
	var wrapped string
	received := map[int64]bool{}
	var hasThumb, hasPreview bool

	if hasResume && idRe.MatchString(resume.ID) {
		var us uploadState
		err := u.c.do(ctx, "GET", "/api/items/"+resume.ID+"/upload", nil, &us)
		var he *httpError
		switch {
		case err == nil && us.State == "ready":
			// finalized, but the run stopped before it noted that
			u.st.put(stateEntry{Key: key, ID: resume.ID, Done: true})
			u.stats.skipped.Add(1)
			u.stats.bytesTotal.Add(-f.Size)
			return nil
		case err == nil && us.State == "uploading" && us.Size == f.Size && us.Count == count:
			wk, err := b64.DecodeString(resume.Wrapped)
			if err == nil {
				itemKey, err = unwrapItemKey(wk, u.master, resume.ID)
			}
			if err == nil {
				id, wrapped = resume.ID, resume.Wrapped
				for _, n := range us.Received {
					received[n] = true
				}
				hasThumb, hasPreview = us.HasThumb, us.HasPrev
			}
		case errors.As(err, &he) && he.Status == 404:
			// the server dropped it (unfinished uploads are removed after two days): start over
		case err != nil:
			return err
		}
	}
	if id == "" {
		var created struct {
			ID string `json:"id"`
		}
		if err := u.c.do(ctx, "POST", "/api/items", map[string]any{"kind": f.Kind, "size": f.Size, "segment_count": count}, &created); err != nil {
			var he *httpError
			if errors.As(err, &he) && he.Status == 429 {
				return errors.New("the server has too many unfinished uploads for this account; finish or cancel them in the web app (or wait two days), then run this again")
			}
			return err
		}
		if !idRe.MatchString(created.ID) {
			return errors.New("the server returned an unexpected item id")
		}
		id = created.ID
		itemKey = randBytes(32)
		wrapped = b64.EncodeToString(wrapItemKey(itemKey, u.master, id))
		if err := u.st.put(stateEntry{Key: key, ID: id, Wrapped: wrapped}); err != nil {
			return fmt.Errorf("could not write the resume file: %w", err)
		}
	}
	defer clear(itemKey)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var thumbErr error
	var thumbWG sync.WaitGroup
	if !hasThumb || !hasPreview {
		thumbWG.Add(1)
		go func() {
			defer thumbWG.Done()
			t, err := makeThumbs(ctx, f, info, u.tmp)
			if err != nil {
				if ctx.Err() == nil {
					u.note("no thumbnail for %s: %v", f.Rel, err)
				}
				return
			}
			if !hasThumb {
				if err := u.c.do(ctx, "PUT", "/api/items/"+id+"/thumb", encryptThumb(t.thumb, itemKey, id), nil); err != nil {
					thumbErr = err
					return
				}
			}
			if !hasPreview {
				thumbErr = u.c.do(ctx, "PUT", "/api/items/"+id+"/preview", encryptPreview(t.preview, itemKey, id), nil)
			}
		}()
	} else if info.Meta.Width == 0 && f.Kind == "image" {
		if w, h := sipsSize(ctx, f.Path); w > 0 {
			if info.orientation >= 5 && info.orientation <= 8 {
				w, h = h, w
			}
			info.Meta.Width, info.Meta.Height = w, h
		}
	}

	var sentHere atomic.Int64 // this file's share of bytesDone, taken back out if it fails
	defer func() {
		if err != nil {
			u.stats.bytesDone.Add(-sentHere.Load())
			u.stats.bytesTotal.Add(-f.Size)
		}
	}()
	// the original's SHA-256 for the metadata (docs/CRYPTO.md), read alongside the parts: those go out several at a
	// time and out of order, and a resumed upload skips the ones the server has
	hashed := make(chan string, 1)
	go func() { hashed <- fileSHA256(ctx, f.Path, f.Size) }()
	if err := u.sendSegments(ctx, f, id, itemKey, count, received, &sentHere); err != nil {
		cancel()
		thumbWG.Wait()
		return err
	}
	info.Meta.SHA256 = <-hashed
	thumbWG.Wait()
	if thumbErr != nil {
		if errors.Is(thumbErr, errQuota) {
			return thumbErr
		}
		u.note("thumbnail upload failed for %s: %v", f.Rel, thumbErr)
	}
	metaJSON, err := json.Marshal(info.Meta)
	if err != nil {
		return err
	}
	if err := u.c.do(ctx, "POST", "/api/items/"+id+"/finalize", map[string]string{
		"wrapped_item_key": wrapped, "meta_enc": b64.EncodeToString(encryptMeta(metaJSON, itemKey, id)),
	}, nil); err != nil {
		var he *httpError
		if !(errors.As(err, &he) && he.Status == 409 && strings.Contains(he.Msg, "already")) {
			return err
		}
	}
	u.st.put(stateEntry{Key: key, ID: id, Done: true})
	u.stats.done.Add(1)
	return nil
}

// sendSegments reads, encrypts and uploads the parts the server does not have yet, several at a time.
func (u *uploader) sendSegments(ctx context.Context, f *localFile, id string, itemKey []byte, count int64, received map[int64]bool, sentHere *atomic.Int64) error {
	h, err := os.Open(f.Path)
	if err != nil {
		return err
	}
	defer h.Close()
	if fi, err := h.Stat(); err != nil || fi.Size() != f.Size {
		return errors.New("the file changed while it was being uploaded")
	}
	for n := range received {
		if n >= 0 && n < count {
			u.stats.bytesDone.Add(segLen(f.Size, n))
			sentHere.Add(segLen(f.Size, n))
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	next := make(chan int64)
	go func() {
		defer close(next)
		for n := int64(0); n < count; n++ {
			if received[n] {
				continue
			}
			select {
			case next <- n:
			case <-ctx.Done():
				return
			}
		}
	}()
	var once sync.Once
	var first error
	var wg sync.WaitGroup
	for w := 0; w < u.segments; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := range next {
				if err := u.sendSegment(ctx, h, f, id, itemKey, n, count, sentHere); err != nil {
					once.Do(func() { first = err; cancel() })
					return
				}
			}
		}()
	}
	wg.Wait()
	return first
}

// fileSHA256 is the file's SHA-256 in lowercase hex, or "" if it can't be read whole or isn't size bytes long.
func fileSHA256(ctx context.Context, path string, size int64) string {
	h, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer h.Close()
	sum := sha256.New()
	buf := make([]byte, 1<<20)
	var n int64
	for {
		if ctx.Err() != nil {
			return ""
		}
		k, err := h.Read(buf)
		sum.Write(buf[:k])
		n += int64(k)
		if err == io.EOF {
			break
		}
		if err != nil {
			return ""
		}
	}
	if n != size {
		return ""
	}
	return hex.EncodeToString(sum.Sum(nil))
}

func segLen(total, n int64) int64 {
	if total == 0 {
		return 0
	}
	return segmentPlainLen(total, n)
}

func (u *uploader) sendSegment(ctx context.Context, h *os.File, f *localFile, id string, itemKey []byte, n, count int64, sentHere *atomic.Int64) error {
	l := segLen(f.Size, n)
	plain := make([]byte, l)
	if _, err := h.ReadAt(plain, n*segPlain); err != nil && !(errors.Is(err, io.EOF) && l == 0) {
		return fmt.Errorf("reading the file: %w", err)
	}
	ct, err := encryptSegment(itemKey, id, n, count, f.Size, plain)
	clear(plain)
	if err != nil {
		return err
	}
	if err := u.c.do(ctx, "PUT", fmt.Sprintf("/api/items/%s/segments/%d", id, n), ct, nil); err != nil {
		return err
	}
	u.stats.bytesDone.Add(l)
	sentHere.Add(l)
	return nil
}

// ---- progress ----

// note prints a message on a line of its own, above the progress line.
func (u *uploader) note(format string, args ...any) {
	msg := clean(fmt.Sprintf(format, args...))
	if u.tty {
		msg = "\r\033[K" + msg
	}
	fmt.Fprintln(u.log, msg)
}

func human(b float64) string {
	for _, u := range []string{"B", "KB", "MB", "GB"} {
		if b < 1000 || u == "GB" {
			if u == "B" {
				return fmt.Sprintf("%.0f %s", b, u)
			}
			return fmt.Sprintf("%.1f %s", b, u)
		}
		b /= 1000
	}
	return ""
}

func eta(d time.Duration) string {
	d = d.Round(time.Second)
	h, m, s := int(d.Hours()), int(d.Minutes())%60, int(d.Seconds())%60
	if h > 0 {
		return fmt.Sprintf("%dh%02dm", h, m)
	}
	return fmt.Sprintf("%dm%02ds", m, s)
}

// progress prints one line every second on a terminal (every 30 s otherwise) until stop is closed. The speed is
// the average over the last 20 seconds of bytes actually sent.
func (u *uploader) progress(stop <-chan struct{}, tty bool) {
	type sample struct {
		t time.Time
		b int64
	}
	var win []sample
	every := time.Second
	if !tty {
		every = 30 * time.Second
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	lastPrint := time.Time{}
	for {
		select {
		case <-stop:
			return
		case now := <-tick.C:
			win = append(win, sample{now, u.c.sent.Load()})
			for len(win) > 21 {
				win = win[1:]
			}
			if now.Sub(lastPrint) < every {
				continue
			}
			lastPrint = now
			speed := 0.0
			if len(win) > 1 {
				a, b := win[0], win[len(win)-1]
				speed = float64(b.b-a.b) / b.t.Sub(a.t).Seconds()
			}
			s := &u.stats
			finished := s.done.Load() + s.skipped.Load() + s.dup.Load() + s.failed.Load()
			left := s.bytesTotal.Load() - s.bytesDone.Load()
			et := "--"
			if speed > 1000 && left > 0 {
				et = eta(time.Duration(float64(left) / speed * float64(time.Second)))
			}
			line := fmt.Sprintf("%d/%d files  %s of %s  %s/s  %s left", finished, s.total.Load(),
				human(float64(s.bytesDone.Load())), human(float64(s.bytesTotal.Load())), human(speed), et)
			if tty {
				fmt.Fprintf(u.log, "\r\033[K%s", line)
			} else {
				fmt.Fprintln(u.log, line)
			}
		}
	}
}
