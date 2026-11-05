package main

import (
	"sync"
	"time"
)

// limiter counts failures per key within a window; blocks once max is reached.
// In-memory: fine for a single instance; resets on restart.
type limiter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	m      map[string]*entry
	now    func() time.Time
	swept  time.Time // last sweep of expired entries
}

type entry struct {
	count int
	reset time.Time
}

func newLimiter(window time.Duration, max int) *limiter {
	return &limiter{window: window, max: max, m: map[string]*entry{}, now: time.Now}
}

func (l *limiter) allowed(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.m[key]
	if e == nil || l.now().After(e.reset) {
		return true
	}
	return e.count < l.max
}

func (l *limiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	l.sweep(t)
	e := l.m[key]
	if e == nil || t.After(e.reset) {
		e = &entry{reset: t.Add(l.window)}
		l.m[key] = e
	}
	e.count++
}

// sweep drops expired entries once the map is large, at most once a minute: a sweep walks the whole map under the
// lock, and doing that on every call would make each request as slow as the number of sources seen.
func (l *limiter) sweep(t time.Time) {
	if len(l.m) <= 10000 || t.Sub(l.swept) < time.Minute {
		return
	}
	l.swept = t
	for k, e := range l.m {
		if t.After(e.reset) {
			delete(l.m, k)
		}
	}
}

func (l *limiter) clear(key string) {
	l.mu.Lock()
	delete(l.m, key)
	l.mu.Unlock()
}

// take atomically counts one attempt for key and reports whether it was within the limit. Unlike allowed()+fail(),
// concurrent requests cannot all pass the check before any of them is counted.
func (l *limiter) take(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	l.sweep(t)
	e := l.m[key]
	if e == nil || t.After(e.reset) {
		e = &entry{reset: t.Add(l.window)}
		l.m[key] = e
	}
	if e.count >= l.max {
		return false
	}
	e.count++
	return true
}

// give returns one counted attempt (used to refund a successful or rejected request).
func (l *limiter) give(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := l.m[key]; e != nil && e.count > 0 {
		e.count--
	}
}

// slot is one limiter bucket an attempt must fit into; clearOnOK resets it on success, otherwise it is refunded.
type slot struct {
	l         *limiter
	key       string
	clearOnOK bool
}

type attempt struct{ slots []slot }

// reserve counts the attempt in every bucket before the expensive credential check runs. If any bucket is full,
// everything already counted is refunded and ok is false.
func reserve(slots ...slot) (*attempt, bool) {
	at := &attempt{}
	for _, s := range slots {
		if !s.l.take(s.key) {
			for _, t := range at.slots {
				t.l.give(t.key)
			}
			return nil, false
		}
		at.slots = append(at.slots, s)
	}
	return at, true
}

// refund returns the attempt to every bucket, for a request that was turned away before anything was checked.
func (at *attempt) refund() {
	for _, s := range at.slots {
		s.l.give(s.key)
	}
}

// success is called after the credential was verified: per-account buckets reset, shared buckets are refunded.
func (at *attempt) success() {
	for _, s := range at.slots {
		if s.clearOnOK {
			s.l.clear(s.key)
		} else {
			s.l.give(s.key)
		}
	}
}
