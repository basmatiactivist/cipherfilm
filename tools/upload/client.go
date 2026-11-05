package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// errQuota stops the whole run: nothing more fits.
var errQuota = errors.New("your storage on the server is full (the server refused more data). Free up space or ask the admin for a larger limit, then run this again")

// errSignIn stops the whole run: the session ended and could not be renewed.
var errSignIn = errors.New("the session ended and signing in again failed")

type httpError struct {
	Status int
	Msg    string
}

func (e *httpError) Error() string {
	if e.Msg != "" {
		return fmt.Sprintf("server: %s (HTTP %d)", e.Msg, e.Status)
	}
	return fmt.Sprintf("server answered HTTP %d", e.Status)
}

type client struct {
	base  *url.URL
	http  *http.Client
	email string

	// sign-in: the login proof derived from the password stays in memory, so an expired session can be renewed
	// without asking again (the password itself is dropped once it has been stretched)
	authProof      string
	wrappedPrivkey string // to open item keys sealed by the phone's background backup (duplicate check)
	mu             sync.Mutex
	csrf           string
	gen            int64 // bumped on every sign-in

	sent atomic.Int64 // bytes of request bodies written, for the progress line
	// tests shorten the waits
	backoff func(attempt int) time.Duration
}

func newClient(server, email, caFile string, conns int) (*client, error) {
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("--server must be an address like https://photos.example.com")
	}
	if u.Scheme != "https" {
		return nil, fmt.Errorf("--server must start with https:// (the server only keeps sessions over HTTPS)")
	}
	tc := &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("%s holds no PEM certificate", caFile)
		}
		tc.RootCAs = pool
	}
	jar, _ := cookiejar.New(nil)
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       tc,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 3 * time.Minute, // the server writes and syncs a part before it answers
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          conns + 4,
		MaxIdleConnsPerHost:   conns + 4,
		// HTTP/1.1 on purpose: each part gets its own TCP connection with its own congestion window, which keeps a
		// long, high-latency line fuller than many streams sharing one HTTP/2 connection
		TLSNextProto:      map[string]func(string, *tls.Conn) http.RoundTripper{},
		ForceAttemptHTTP2: false,
		WriteBufferSize:   256 << 10,
	}
	return &client{base: u, http: &http.Client{Transport: tr, Jar: jar}, email: email, backoff: defaultBackoff}, nil
}

func defaultBackoff(attempt int) time.Duration {
	d := time.Second << min(attempt, 6) // 1 s, 2 s, 4 s … up to about a minute
	return min(d, 60*time.Second)
}

const maxAttempts = 12 // with the backoff above: keeps trying for about eight minutes

// countingReader counts body bytes as the transport sends them.
type countingReader struct {
	r *bytes.Reader
	c *client
	n int64
}

func (cr *countingReader) Read(p []byte) (int, error) {
	n, err := cr.r.Read(p)
	cr.n += int64(n)
	cr.c.sent.Add(int64(n))
	return n, err
}

// do sends one request, retrying network errors, 5xx, 408 and 429 with backoff, and signing in again on a 401.
// body is JSON-encoded unless it is []byte (sent as application/octet-stream). out, if not nil, receives the JSON answer.
func (c *client) do(ctx context.Context, method, path string, body any, out any) error {
	var raw []byte
	ctype := ""
	switch b := body.(type) {
	case nil:
	case []byte:
		raw, ctype = b, "application/octet-stream"
	default:
		j, err := json.Marshal(b)
		if err != nil {
			return err
		}
		raw, ctype = j, "application/json"
	}
	signedInAgain := false
	var last error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.backoff(attempt - 1)):
			}
		}
		c.mu.Lock()
		csrf, gen := c.csrf, c.gen
		c.mu.Unlock()
		status, msg, err := c.once(ctx, method, path, raw, ctype, csrf, out)
		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case err != nil:
			last = err // network: try again
			continue
		case status < 300:
			return nil
		case status == 401 && !signedInAgain && path != "/api/auth/login":
			signedInAgain = true
			if err := c.relogin(ctx, gen); err != nil {
				return err
			}
			attempt-- // a fresh session is not a failed attempt
			continue
		case status == 413:
			return errQuota
		case status >= 500 || status == 408 || status == 429:
			last = &httpError{status, msg}
			continue
		default:
			return &httpError{status, msg}
		}
	}
	return last
}

func (c *client) once(ctx context.Context, method, path string, raw []byte, ctype, csrf string, out any) (int, string, error) {
	// one part may take a while on a slow line, but a connection that stopped moving must not hang the run
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	var rd io.Reader
	var cr *countingReader
	if raw != nil {
		cr = &countingReader{r: bytes.NewReader(raw), c: c}
		rd = cr
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base.String()+path, rd)
	if err != nil {
		return 0, "", err
	}
	if raw != nil {
		req.ContentLength = int64(len(raw))
		req.Header.Set("Content-Type", ctype)
		req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(raw)), nil }
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "cipherfilm-upload/"+version)
	if csrf != "" && method != http.MethodGet {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if cr != nil {
			c.sent.Add(-cr.n) // it will be sent again
		}
		return 0, "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		if cr != nil {
			c.sent.Add(-cr.n)
		}
		return 0, "", err
	}
	if resp.StatusCode >= 300 {
		if cr != nil {
			c.sent.Add(-cr.n)
		}
		var e struct {
			Error string `json:"error"`
		}
		json.Unmarshal(data, &e)
		return resp.StatusCode, clean(e.Error), nil
	}
	if b, ok := out.(*[]byte); ok {
		*b = data
	} else if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return 0, "", fmt.Errorf("unexpected answer from the server: %v", err)
		}
	}
	return resp.StatusCode, "", nil
}

type sessionBundle struct {
	User struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	} `json:"user"`
	CSRF            string `json:"csrf"`
	WrappedMasterPW string `json:"wrapped_master_pw"`
	WrappedPrivkey  string `json:"wrapped_privkey"`
}

// login stretches the password with the account's parameters, signs in and unlocks the master key.
func (c *client) login(ctx context.Context, password string) (master []byte, userID string, err error) {
	var kdf kdfParams
	if err := c.do(ctx, "GET", "/api/auth/params?email="+url.QueryEscape(normEmail(c.email)), nil, &kdf); err != nil {
		return nil, "", err
	}
	authKey, kek, err := deriveFromPassword(password, kdf)
	if err != nil {
		return nil, "", err
	}
	c.authProof = b64.EncodeToString(authKey)
	clear(authKey)
	var s sessionBundle
	if err := c.signIn(ctx, &s); err != nil {
		return nil, "", err
	}
	wrapped, err := b64.DecodeString(s.WrappedMasterPW)
	if err != nil {
		return nil, "", errors.New("the server sent a bad key")
	}
	master, err = unlockMasterKey(c.email, kek, wrapped)
	clear(kek)
	if err != nil {
		return nil, "", errors.New("could not unlock your library with this password")
	}
	c.wrappedPrivkey = s.WrappedPrivkey
	return master, s.User.ID, nil
}

func (c *client) signIn(ctx context.Context, s *sessionBundle) error {
	err := c.do(ctx, "POST", "/api/auth/login", map[string]string{"email": normEmail(c.email), "auth": c.authProof}, s)
	var he *httpError
	if errors.As(err, &he) && he.Status == 401 {
		return errors.New("wrong e-mail or password")
	}
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.csrf = s.CSRF
	c.gen++
	c.mu.Unlock()
	return nil
}

var reloginMu sync.Mutex

// relogin renews the session once, however many requests noticed it had expired at the same time.
func (c *client) relogin(ctx context.Context, sawGen int64) error {
	reloginMu.Lock()
	defer reloginMu.Unlock()
	c.mu.Lock()
	cur := c.gen
	c.mu.Unlock()
	if cur != sawGen {
		return nil // someone else already signed in again
	}
	var s sessionBundle
	if err := c.signIn(ctx, &s); err != nil {
		return fmt.Errorf("%w: %v", errSignIn, err)
	}
	return nil
}
