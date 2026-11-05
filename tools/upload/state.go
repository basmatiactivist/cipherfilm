package main

// The resume file remembers, per server and account, which local files were uploaded and which are half done. It holds
// the item id and the item key wrapped under the master key (useless without the password), never a plaintext key.
// It is an append-only log of JSON lines, so recording one finished file costs one short write, not a rewrite of
// thousands of entries; it is compacted when it is opened.

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type stateEntry struct {
	Key     string `json:"k"` // path NUL size NUL mtime (ns)
	ID      string `json:"id,omitempty"`
	Wrapped string `json:"w,omitempty"`
	Done    bool   `json:"done,omitempty"`
	Forget  bool   `json:"forget,omitempty"`
}

type state struct {
	mu      sync.Mutex
	path    string
	f       *os.File
	entries map[string]stateEntry
}

func stateDir() (string, error) {
	if d := os.Getenv("CIPHERFILM_UPLOAD_STATE"); d != "" {
		return d, nil
	}
	d, err := os.UserConfigDir() // ~/Library/Application Support on macOS
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "cipherfilm-upload"), nil
}

// statePath names the file after a hash of server and account, so it says nothing about either.
func statePath(server, email string) (string, error) {
	d, err := stateDir()
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(server + "\n" + normEmail(email)))
	return filepath.Join(d, hex.EncodeToString(h[:12])+".jsonl"), nil
}

func openState(path string) (*state, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	s := &state{path: path, entries: map[string]stateEntry{}}
	if f, err := os.Open(path); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			var e stateEntry
			if json.Unmarshal(sc.Bytes(), &e) != nil || e.Key == "" {
				continue // a line cut short by a crash
			}
			if e.Forget {
				delete(s.entries, e.Key)
			} else {
				s.entries[e.Key] = e
			}
		}
		f.Close()
	}
	// compact: write what is current to a new file and swap it in
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	w := bufio.NewWriter(f)
	for _, e := range s.entries {
		b, _ := json.Marshal(e)
		w.Write(append(b, '\n'))
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return nil, err
	}
	f.Close()
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	s.f, err = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	return s, err
}

func (s *state) get(key string) (stateEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[key]
	return e, ok
}

func (s *state) put(e stateEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.Forget {
		delete(s.entries, e.Key)
	} else {
		s.entries[e.Key] = e
	}
	b, _ := json.Marshal(e)
	if _, err := s.f.Write(append(b, '\n')); err != nil {
		return err
	}
	return s.f.Sync()
}

func (s *state) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f != nil {
		s.f.Close()
	}
}
