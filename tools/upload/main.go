// cipherfilm-upload encrypts the photos and videos in a folder on this Mac and uploads them to a Cipherfilm server,
// in exactly the format of the web app. It continues where it stopped when it is run again.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"golang.org/x/term"
)

var version = "dev" // set at build time

var testClient func(*client) // lets tests trust their own server

const usage = `cipherfilm-upload: encrypt the photos and videos in a folder and upload them to your Cipherfilm.

Usage:
  cipherfilm-upload --server https://photos.example.com --email you@example.org [options] FOLDER

Everything in FOLDER and its subfolders that is a photo or a video (JPEG, PNG, WebP, HEIC, GIF, DNG, MP4, MOV, M4V) is
encrypted on this computer and uploaded; hidden files are skipped. Files already in your library (same name, size and
capture time) are skipped too. If the upload stops, run the same command again: finished files are skipped and
half-finished ones continue where they stopped.

Options:
  --server URL          your Cipherfilm address (https://...)
  --email ADDRESS       your account
  --password-file F     read the password from a file (default: ask; or set CIPHERFILM_PASSWORD)
  --parallel N          files uploaded at the same time (default 3, at most 10)
  --segments N          parts of one file uploaded at the same time (default 3, at most 8)
  --allow-duplicates    upload files even if the library already has them
  --ca-file F           also trust this certificate authority (PEM), for a server with its own certificate
  --version             print the version and exit
`

type options struct {
	server, email, pwFile, caFile string
	parallel, segments            int
	allowDup, showVersion         bool
}

func main() {
	var o options
	fs := flag.NewFlagSet("cipherfilm-upload", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&o.server, "server", "", "")
	fs.StringVar(&o.email, "email", "", "")
	fs.StringVar(&o.pwFile, "password-file", "", "")
	fs.StringVar(&o.caFile, "ca-file", "", "")
	fs.IntVar(&o.parallel, "parallel", 3, "")
	fs.IntVar(&o.segments, "segments", 3, "")
	fs.BoolVar(&o.allowDup, "allow-duplicates", false, "")
	fs.BoolVar(&o.showVersion, "version", false, "")
	err := fs.Parse(os.Args[1:])
	if o.showVersion {
		fmt.Println("cipherfilm-upload", version)
		return
	}
	if err != nil || fs.NArg() != 1 || o.server == "" || o.email == "" {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if o.parallel < 1 || o.parallel > 10 || o.segments < 1 || o.segments > 8 {
		fmt.Fprintln(os.Stderr, "error: --parallel must be 1-10 and --segments 1-8")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	go func() {
		<-ctx.Done()
		stop() // a second Ctrl-C ends the program at once
	}()
	code, err := run(ctx, o, fs.Arg(0), os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "\nerror:", clean(err.Error()))
	}
	os.Exit(code)
}

func readPassword(file string) (string, error) {
	if file != "" {
		b, err := os.ReadFile(file)
		return strings.TrimRight(string(b), "\r\n"), err
	}
	if v := os.Getenv("CIPHERFILM_PASSWORD"); v != "" {
		return v, nil
	}
	fmt.Fprint(os.Stderr, "Password: ")
	if term.IsTerminal(int(os.Stdin.Fd())) {
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		return string(b), err
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.TrimRight(line, "\r\n"), err
}

// run returns the exit code: 0 all done, 1 some files failed or the run stopped, 130 interrupted.
func run(ctx context.Context, o options, folder string, w io.Writer) (int, error) {
	log := &lockedWriter{w: w} // the progress line and the workers' messages share it
	files, tooLarge, err := scan(folder)
	if err != nil {
		return 1, err
	}
	for _, p := range tooLarge {
		fmt.Fprintf(log, "skipped %s: larger than 8 GB, the most the server accepts\n", clean(p))
	}
	if len(files) == 0 {
		fmt.Fprintln(log, "No photos or videos found in this folder.")
		return 0, nil
	}
	c, err := newClient(o.server, o.email, o.caFile, o.parallel*o.segments)
	if err != nil {
		return 2, err
	}
	if testClient != nil {
		testClient(c)
	}
	sp, err := statePath(c.base.String(), o.email)
	if err != nil {
		return 1, err
	}
	unlock, err := lockFile(sp + ".lock")
	if err != nil {
		return 1, err
	}
	defer unlock()
	st, err := openState(sp)
	if err != nil {
		return 1, fmt.Errorf("resume file %s: %w", sp, err)
	}
	defer st.close()

	pw, err := readPassword(o.pwFile)
	if err != nil {
		return 1, err
	}
	fmt.Fprintln(log, "Signing in…")
	master, _, err := c.login(ctx, pw)
	pw = ""
	if err != nil {
		return 1, err
	}
	defer clear(master)

	tmp, err := os.MkdirTemp("", "cipherfilm-upload-")
	if err != nil {
		return 1, err
	}
	defer os.RemoveAll(tmp)
	tty := w == io.Writer(os.Stderr) && term.IsTerminal(int(os.Stderr.Fd()))
	u := &uploader{c: c, master: master, st: st, segments: o.segments, tmp: tmp, allowDup: o.allowDup, log: log, tty: tty}

	fmt.Fprintln(log, "Reading your library…")
	n, quotaLeft, unlimited, err := u.loadLibrary(ctx)
	if err != nil {
		return 1, err
	}
	var need int64
	for _, f := range files {
		need += f.Size
	}
	fmt.Fprintf(log, "%d photos and videos in the folder (%s), %d items in your library.\n", len(files), human(float64(need)), n)
	if !unlimited && quotaLeft < need {
		fmt.Fprintf(log, "Note: your storage has %s left; the upload stops once it is full (files already in the library are skipped and need no space).\n", human(float64(max(0, quotaLeft))))
	}
	u.stats.total.Store(int64(len(files)))
	u.stats.bytesTotal.Store(need)

	stopProgress := make(chan struct{})
	var pwg sync.WaitGroup
	pwg.Add(1)
	go func() { defer pwg.Done(); u.progress(stopProgress, tty) }()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan *localFile)
	var fatal error
	var fatalOnce sync.Once
	var failedMu sync.Mutex
	var failed []string
	var wg sync.WaitGroup
	for w := 0; w < o.parallel; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for f := range jobs {
				err := u.uploadOne(ctx, f)
				if err == nil {
					continue
				}
				if ctx.Err() != nil {
					return
				}
				if errors.Is(err, errQuota) || errors.Is(err, errSignIn) {
					fatalOnce.Do(func() { fatal = err; cancel() })
					return
				}
				u.stats.failed.Add(1)
				failedMu.Lock()
				failed = append(failed, fmt.Sprintf("%s: %v", f.Rel, err))
				failedMu.Unlock()
				u.note("failed: %s: %v", f.Rel, err)
			}
		}()
	}
feed:
	for _, f := range files {
		select {
		case jobs <- f:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	close(stopProgress)
	pwg.Wait()
	if tty {
		fmt.Fprint(log, "\r\033[K")
	}

	s := &u.stats
	fmt.Fprintf(log, "Uploaded %d, already done earlier %d, already in the library %d, failed %d (of %d).\n",
		s.done.Load(), s.skipped.Load(), s.dup.Load(), s.failed.Load(), len(files))
	switch {
	case fatal != nil:
		return 1, fmt.Errorf("%v\nWhat was uploaded so far is kept; run the same command again to continue", fatal)
	case ctx.Err() != nil:
		fmt.Fprintln(log, "Stopped. Run the same command again to continue where it stopped.")
		return 130, nil
	case len(failed) > 0:
		fmt.Fprintln(log, "Some files failed (listed above). Run the same command again to retry them.")
		return 1, nil
	}
	fmt.Fprintln(log, "All done.")
	return 0, nil
}

type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// lockFile keeps two runs for the same server and account from working on the same resume file at once.
func lockFile(path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another cipherfilm-upload for this server and account is already running")
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}

// clean keeps terminal control characters (from file names or server messages) out of the output.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return '?'
		}
		return r
	}, s)
}
