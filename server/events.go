package main

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Live updates: GET /api/events is a Server-Sent Events stream that tells a person's other devices that something in
// the account changed (a photo uploaded on the phone, an album renamed on the Mac), so they load it again within a
// second or two instead of at their next refresh. A ping carries a counter and which lists changed (items, trash,
// albums, the people document, the search index), never what changed: the server couldn't read that anyway, and the
// device fetches it through the usual, authenticated API.
//
// The stream lives as long as the session does: every heartbeat checks the session again, and signing a device out,
// changing the password, disabling or deleting the account check it at once. Every stream costs a connection and a
// goroutine, so there are only so many per session, per account and in all; one more is refused with 429.

type topic uint8

const (
	tItems topic = 1 << iota
	tTrash
	tAlbums
	tPeople
	tIndex
)

var topicNames = []struct {
	t topic
	n string
}{{tItems, "items"}, {tTrash, "trash"}, {tAlbums, "albums"}, {tPeople, "people"}, {tIndex, "index"}}

func (t topic) names() []string {
	out := []string{}
	for _, x := range topicNames {
		if t&x.t != 0 {
			out = append(out, x.n)
		}
	}
	return out
}

// vars for the tests
var (
	eventHeartbeat = 25 * time.Second // a comment line, so proxies and the apps see the stream is alive
	eventGap       = time.Second      // at most one ping a second: a burst of changes (an import) arrives as one
	eventWriteTime = 30 * time.Second // a client that stops reading is cut off
	eventRetry     = 3 * time.Second  // EventSource's own wait before it reconnects
	streamsPerSess = 8                // tabs of one browser share the session
	streamsPerAcct = 32               // all devices of one account
	streamsInAll   = 2000             // the whole server
)

var errTooMany = errors.New("too many open streams")

type stream struct {
	user, sess string
	wake       chan struct{} // capacity 1: a poke while one is pending is merged into it
	what       topic         // pending, guarded by hub.mu
	check      bool          // the session is to be checked again (signed out, password changed), guarded by hub.mu
}

type hub struct {
	mu    sync.Mutex
	epoch uint64                          // the counters start here, so a restarted server's counter differs
	seq   map[string]uint64               // per account: bumped by every change
	subs  map[string]map[*stream]struct{} // per account
	n     int
}

func newHub(now time.Time) *hub {
	return &hub{epoch: uint64(now.UnixMilli()), seq: map[string]uint64{}, subs: map[string]map[*stream]struct{}{}}
}

func (h *hub) version(user string) uint64 {
	if v, ok := h.seq[user]; ok {
		return v
	}
	return h.epoch
}

func (s *stream) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// changed is called after a change to the account has been committed.
func (h *hub) changed(user string, t topic) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq[user] = h.version(user) + 1
	for s := range h.subs[user] {
		s.what |= t
		s.poke()
	}
}

// recheck makes every stream of the account check its session now (one may just have been signed out).
func (h *hub) recheck(user string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs[user] {
		s.check = true
		s.poke()
	}
}

func (h *hub) join(user, sess string) (*stream, uint64, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	mine := 0
	for s := range h.subs[user] {
		if s.sess == sess {
			mine++
		}
	}
	if h.n >= streamsInAll || len(h.subs[user]) >= streamsPerAcct || mine >= streamsPerSess {
		return nil, 0, errTooMany
	}
	s := &stream{user: user, sess: sess, wake: make(chan struct{}, 1)}
	if h.subs[user] == nil {
		h.subs[user] = map[*stream]struct{}{}
	}
	h.subs[user][s] = struct{}{}
	h.n++
	return s, h.version(user), nil
}

func (h *hub) leave(s *stream) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[s.user][s]; !ok {
		return
	}
	delete(h.subs[s.user], s)
	h.n--
	if len(h.subs[s.user]) == 0 {
		delete(h.subs, s.user)
	}
}

// take returns what changed since the last ping and clears it.
func (h *hub) take(s *stream) (what topic, check bool, v uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	what, check, v = s.what, s.check, h.version(s.user)
	s.what, s.check = 0, false
	return
}

// count is the number of open streams (for the tests).
func (h *hub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.n
}

// changed: the account's other devices should load these lists again.
func (a *App) changed(user string, t topic) { a.live.changed(user, t) }

// sessionLive checks the stream's session as auth does, without moving its expiry forward: an open tab alone doesn't
// keep a session alive. A database that can't answer right now doesn't end the stream; the next heartbeat asks again.
func (a *App) sessionLive(idHash string) bool {
	var exp, last int64
	var status string
	err := a.db.QueryRow(`SELECT s.expires_at, s.last_seen, u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?`, idHash).
		Scan(&exp, &last, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		return true
	}
	now := a.now().Unix()
	return now <= exp && now-last <= int64(sessionIdle.Seconds()) && status == "active"
}

func (a *App) eventRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/events", a.auth(false, a.events))
}

func (a *App) events(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	st, v, err := a.live.join(u.ID, s.IDHash)
	if err != nil {
		w.Header().Set("Retry-After", "60")
		fail(w, http.StatusTooManyRequests, "too many open connections")
		return
	}
	defer a.live.leave(st)
	rc := http.NewResponseController(w)
	// no body to read: the short read deadline every request starts with (bodyLimit) would otherwise end the stream,
	// since net/http cancels a request whose connection read fails. A client that stops reading is caught by the
	// write deadline instead, at the next heartbeat at the latest.
	rc.SetReadDeadline(time.Time{})
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no") // nginx: pass every ping on at once
	w.WriteHeader(http.StatusOK)
	send := func(msg string) bool {
		rc.SetWriteDeadline(time.Now().Add(eventWriteTime))
		if _, err := io.WriteString(w, msg); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	ping := func(name string, v uint64, what topic) bool {
		data := fmt.Sprintf(`{"v":%d`, v)
		if name == "changed" {
			data += `,"what":["` + strings.Join(what.names(), `","`) + `"]`
		}
		return send("event: " + name + "\ndata: " + data + "}\n\n")
	}
	bye := func() { send("event: bye\ndata: {}\n\n") }
	// retry: how long EventSource waits before it reconnects by itself
	if !send(fmt.Sprintf("retry: %d\n", eventRetry.Milliseconds())) || !ping("ready", v, 0) {
		return
	}
	beat := time.NewTicker(eventHeartbeat)
	defer beat.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-beat.C:
			if !a.sessionLive(s.IDHash) {
				bye()
				return
			}
			if !send(":\n\n") {
				return
			}
		case <-st.wake:
			what, check, v := a.live.take(st)
			if check && !a.sessionLive(s.IDHash) {
				bye()
				return
			}
			if what == 0 {
				continue
			}
			if !ping("changed", v, what) {
				return
			}
			gap := time.NewTimer(eventGap)
			select {
			case <-ctx.Done():
				gap.Stop()
				return
			case <-gap.C:
			}
		}
	}
}
