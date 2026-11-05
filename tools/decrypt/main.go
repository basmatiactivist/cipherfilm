// cipherfilm-decrypt restores the original photos and videos from a Cipherfilm backup, without the app or its server.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
	"golang.org/x/text/unicode/norm"
)

const usage = `cipherfilm-decrypt: get your photos back from a Cipherfilm backup, with no app and no server.

Usage:
  cipherfilm-decrypt [options] BACKUP_FOLDER

BACKUP_FOLDER is the data folder of an instance (app.db and blobs/, no backup step needed), a copy of the Docker volume,
or an extracted backup (backup/app.db and blobs/). If both a live database and an older snapshot are present, the newer one
is used. Nothing in the folder is modified, and nothing is sent anywhere: this program never uses the network.

Options:
  --list              show the accounts in the backup and exit (needs no password)
  --email ADDRESS     which account to restore (needed when the backup holds several)
  --out FOLDER        where to write the originals (default ./cipherfilm-restored)
  --recovery          unlock with the 24-word recovery key instead of the password
  --password-file F   read the password from a file (default: ask; or set CIPHERFILM_PASSWORD)
  --recovery-file F   read the recovery words from a file
  --verify            check that everything decrypts, but write no files
  --no-albums         do not create the Albums folder
  --skip-trash        leave out items that were in the trash
`

type options struct {
	list, recovery, verify, noAlbums, skipTrash bool
	email, out, pwFile, recFile                 string
}

func main() {
	var o options
	fs := flag.NewFlagSet("cipherfilm-decrypt", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.BoolVar(&o.list, "list", false, "")
	fs.BoolVar(&o.recovery, "recovery", false, "")
	fs.BoolVar(&o.verify, "verify", false, "")
	fs.BoolVar(&o.noAlbums, "no-albums", false, "")
	fs.BoolVar(&o.skipTrash, "skip-trash", false, "")
	fs.StringVar(&o.email, "email", "", "")
	fs.StringVar(&o.out, "out", "cipherfilm-restored", "")
	fs.StringVar(&o.pwFile, "password-file", "", "")
	fs.StringVar(&o.recFile, "recovery-file", "", "")
	if err := fs.Parse(os.Args[1:]); err != nil || fs.NArg() != 1 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err := run(o, fs.Arg(0)); err != nil {
		fmt.Fprintln(os.Stderr, "error:", clean(err.Error())) // errors can carry text from the backup
		os.Exit(1)
	}
}

func readSecret(prompt, file, env string) (string, error) {
	if file != "" {
		b, err := os.ReadFile(file)
		return strings.TrimRight(string(b), "\r\n"), err
	}
	if env != "" {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
	}
	fmt.Fprint(os.Stderr, prompt)
	if term.IsTerminal(int(os.Stdin.Fd())) {
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		return string(b), err
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.TrimRight(line, "\r\n"), err
}

func run(o options, root string) error {
	b, err := openBackup(root)
	if err != nil {
		return err
	}
	defer b.Close()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() { <-sig; b.Close(); os.Exit(130) }() // do not leave the temporary copy of the database behind
	accts, err := b.accounts()
	if err != nil {
		return err
	}
	if o.list {
		fmt.Printf("Backup: %s\nblobs:  %s\n\n", b.dbPath, b.blobs)
		for _, a := range accts {
			fmt.Printf("  %-40s %d items\n", clean(a.Email), a.Items)
		}
		return nil
	}
	var acct *account
	switch {
	case o.email != "":
		for i := range accts {
			if accts[i].Email == normEmail(o.email) {
				acct = &accts[i]
			}
		}
		if acct == nil {
			return fmt.Errorf("no account %q in this backup (try --list)", o.email)
		}
	case len(accts) == 1:
		acct = &accts[0]
	default:
		return errors.New("this backup holds several accounts: choose one with --email (see --list)")
	}

	// unlock the master key
	var master []byte
	if o.recovery {
		words, err := readSecret("Recovery key (24 words): ", o.recFile, "CIPHERFILM_RECOVERY")
		if err != nil {
			return err
		}
		rk, err := wordsToKey(words)
		if err != nil {
			return err
		}
		blob, err := unb64(acct.WrappedMasterRecovery)
		if err != nil {
			return errors.New("unreadable recovery data in the backup")
		}
		if master, err = open(blob, recoveryWrapKey(rk), "wrap/master/recovery", acct.Email); err != nil {
			return errors.New("that recovery key does not unlock this account")
		}
	} else {
		pw, err := readSecret("Password for "+clean(acct.Email)+": ", o.pwFile, "CIPHERFILM_PASSWORD")
		if err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "Unlocking (this takes a second or two) ...")
		kek, err := passwordKEK(pw, acct.KDF)
		if err != nil {
			return err
		}
		blob, err := unb64(acct.WrappedMasterPW)
		if err != nil {
			return errors.New("unreadable key data in the backup")
		}
		if master, err = open(blob, kek, "wrap/master/pw", acct.Email); err != nil {
			return errors.New("wrong password for " + clean(acct.Email) + " (or an altered backup). Try --recovery with your recovery key")
		}
	}
	return export(b, acct, master, o)
}

// ---- export ----

type meta struct {
	Name      string `json:"name"`
	Mime      string `json:"mime"`
	Size      int64  `json:"size"`
	CaptureTS int64  `json:"capture_ts"`
}

var unsafeName = regexp.MustCompile(`[\x00-\x1f/\\:*?"<>|]`)

func safeName(n, fallback string) string {
	n = strings.TrimSpace(unsafeName.ReplaceAllString(n, "_"))
	n = strings.Trim(n, ". ")
	if n == "" {
		return fallback
	}
	if len(n) > 200 { // keep the extension
		ext := filepath.Ext(n)
		if len(ext) > 16 {
			ext = ""
		}
		n = n[:200-len(ext)] + ext
	}
	return n
}

type exported struct {
	row  itemRow
	path string // relative to the output folder
}

func export(b *backupDir, a *account, master []byte, o options) error {
	keys := newKeyRing(master, a.WrappedPrivkey, a.Email)
	items, err := b.items(a.ID)
	if err != nil {
		return err
	}
	albums, err := b.albums(a.ID)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Restoring %d items for %s%s\n", len(items), clean(a.Email), map[bool]string{true: " (verify only)", false: ""}[o.verify])
	var failures []string
	used := map[string]bool{}
	done := map[string]exported{}
	var bytesOut int64
	for n, it := range items {
		if o.skipTrash && it.Trashed.Valid {
			continue
		}
		path, size, err := restoreItem(b, it, keys, o, used)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", it.ID, err))
			fmt.Fprintf(os.Stderr, "  [%d/%d] FAILED %s\n", n+1, len(items), clean(fmt.Sprintf("%s: %v", it.ID, err)))
			continue
		}
		done[it.ID] = exported{it, path}
		bytesOut += size
		if (n+1)%25 == 0 || n+1 == len(items) {
			fmt.Fprintf(os.Stderr, "  [%d/%d] %s\n", n+1, len(items), path)
		}
	}
	if !o.verify && !o.noAlbums {
		sort.Slice(albums, func(i, j int) bool { return albums[i].ID < albums[j].ID })
		for _, al := range albums {
			name, err := decryptAlbumName(mustB64(al.NameEnc), master, al.ID)
			if err != nil {
				failures = append(failures, "album "+al.ID+": name could not be verified")
				continue
			}
			dir := filepath.Join(o.out, "Albums", safeName(name, al.ID))
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return err
			}
			for _, id := range al.ItemIDs {
				ex, ok := done[id]
				if !ok {
					continue
				}
				link := filepath.Join(dir, filepath.Base(ex.path))
				target, _ := filepath.Rel(dir, filepath.Join(o.out, ex.path))
				os.Remove(link)
				if err := os.Symlink(target, link); err != nil {
					failures = append(failures, "album link "+link+": "+err.Error())
				}
			}
		}
	}
	fmt.Fprintf(os.Stderr, "\nDone: %d items, %s%s.\n", len(done), humanBytes(bytesOut), map[bool]string{true: " verified", false: " written to " + o.out}[o.verify])
	if len(failures) > 0 {
		fmt.Fprintf(os.Stderr, "%d problem(s):\n", len(failures))
		for _, f := range failures {
			fmt.Fprintln(os.Stderr, "  -", clean(f))
		}
		return fmt.Errorf("%d item(s) could not be restored; everything else was", len(failures))
	}
	return nil
}

// segWant is the plaintext length of segment i of a file with the given size.
func segWant(size, i int64) int64 {
	w := size - i*segPlain
	if w > segPlain {
		w = segPlain
	}
	if size == 0 || w < 0 {
		return 0
	}
	return w
}

// readSegment reads exactly want bytes from a regular file. A backup is not trusted: a symlink, FIFO, device or
// oversized file in blobs/ must not hang the tool or exhaust memory.
func readSegment(path string, want int64) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Size() != want {
		return nil, errors.New("unexpected file in the backup")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, want)
	if _, err := io.ReadFull(f, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// clean makes text from the (unauthenticated) database safe to print: control characters, including terminal escapes, become "?".
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return '?'
		}
		return r
	}, s)
}

func mustB64(s string) []byte { b, _ := unb64(s); return b }

func humanBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	}
	return fmt.Sprintf("%d KB", n>>10)
}

// restoreItem decrypts one item and writes it to Library/YYYY/YYYY-MM/name (or Trash/). It returns the relative path.
func restoreItem(b *backupDir, it itemRow, keys *keyRing, o options, used map[string]bool) (string, int64, error) {
	if len(it.ID) != 32 {
		return "", 0, errors.New("unexpected item id")
	}
	wrapped, err := unb64(it.WrappedKey)
	if err != nil || it.WrappedKey == "" {
		return "", 0, errors.New("missing key data")
	}
	itemKey, err := keys.itemKey(wrapped, it.ID)
	if err != nil {
		return "", 0, errors.New("item key could not be verified")
	}
	mb, err := unb64(it.MetaEnc)
	if err != nil {
		return "", 0, errors.New("missing metadata")
	}
	raw, err := decryptMeta(mb, itemKey, it.ID)
	if err != nil {
		return "", 0, errors.New("metadata could not be verified")
	}
	var m meta
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", 0, errors.New("metadata unreadable")
	}
	if m.Size != it.Size {
		return "", 0, errors.New("size in metadata does not match the stored size")
	}
	when := time.UnixMilli(m.CaptureTS)
	if m.CaptureTS <= 0 {
		when = time.Unix(it.Created, 0)
	}
	base := "Library"
	if it.Trashed.Valid {
		base = "Trash"
	}
	rel := filepath.Join(base, when.Format("2006"), when.Format("2006-01"), safeName(m.Name, it.ID))
	// case-insensitive file systems (macOS) treat IMG_1.JPG and img_1.jpg as one file; so does the ".partial" temp name
	for used[strings.ToLower(norm.NFC.String(rel))] || used[strings.ToLower(norm.NFC.String(rel))+".partial"] {
		ext := filepath.Ext(rel)
		rel = strings.TrimSuffix(rel, ext) + "-" + it.ID[:6] + ext
	}
	used[strings.ToLower(norm.NFC.String(rel))] = true
	dst := filepath.Join(o.out, rel)
	var f *os.File
	var tmp string
	if !o.verify {
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return "", 0, err
		}
		tmp = dst + ".partial"
		if f, err = os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644); err != nil {
			return "", 0, err
		}
	}
	fail := func(e error) (string, int64, error) {
		if f != nil {
			f.Close()
			os.Remove(tmp)
		}
		return "", 0, e
	}
	count := segmentCount(it.Size)
	if count != it.Count {
		return fail(errors.New("segment count does not match the file size"))
	}
	for i := int64(0); i < count; i++ {
		blob, err := readSegment(b.segmentPath(it.ID, i), cipherLen(segWant(it.Size, i)))
		if err != nil {
			return fail(fmt.Errorf("encrypted data is missing from the backup (part %d)", i+1))
		}
		plain, err := decryptSegment(itemKey, it.ID, i, count, it.Size, blob)
		if err != nil {
			return fail(fmt.Errorf("part %d failed verification: the backup copy is damaged or altered", i+1))
		}
		if f != nil {
			if _, err := f.Write(plain); err != nil {
				return fail(err)
			}
		}
	}
	if f != nil {
		if err := f.Close(); err != nil {
			os.Remove(tmp)
			return "", 0, err
		}
		if err := os.Rename(tmp, dst); err != nil {
			return "", 0, err
		}
		os.Chtimes(dst, when, when)
	}
	return rel, it.Size, nil
}
