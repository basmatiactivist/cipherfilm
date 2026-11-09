package main

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

//go:embed all:static
var staticFS embed.FS

// The web app's CSP (mapconf.go): set at start from MAP_STYLE, the default map until then.
var csp = buildCSP(defaultMap.origins())

// The HEIC decoder (libheif, built with embind) needs eval. It runs in a dedicated worker served from /heic/,
// which gets a CSP that allows eval but forbids every network request, so it cannot send anything anywhere.
const cspHeic = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'none'; " +
	"worker-src 'none'; child-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// by the path the file server will serve (an escaped "/heic/..%2fsw.js" is not a HEIC worker file)
		if strings.HasPrefix(path.Clean("/"+r.URL.Path), "/heic/") {
			h.Set("Content-Security-Policy", cspHeic)
		} else {
			h.Set("Content-Security-Policy", csp)
		}
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY") // frame-ancestors 'none' for browsers that predate it
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
		h.Set("Strict-Transport-Security", "max-age=31536000")
		// a private photo server: no search engine lists it, not even its sign-in page
		h.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
		next.ServeHTTP(w, r)
	})
}

func (a *App) handler() http.Handler {
	root := http.NewServeMux()
	root.Handle("/api/", a.routes())
	root.Handle("/healthz", a.routes())
	// /sw/stream/ exists only inside the Service Worker; if a request ever reaches the server it gets nothing.
	root.HandleFunc("/sw/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatal(err)
	}
	// crawlers may fetch the page itself, so they see its noindex (a page they may not fetch can still be listed by its
	// address alone); the API they have no business with
	root.HandleFunc("GET /robots.txt", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "User-agent: *\nDisallow: /api/\n")
	})
	root.Handle("/", newStatic(sub))
	return bodyLimit(a.hostGuard(securityHeaders(root)))
}

// bodyLimit gives every request the short body deadline first: also those answered without reading their body
// (refused, unknown route), whose leftover body net/http drains afterwards. Upload handlers extend it for their part.
func bodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodyDeadline(w, jsonReadTime)
		next.ServeHTTP(w, r)
	})
}

func healthcheck(addr string) int {
	c := http.Client{Timeout: 3 * time.Second}
	// only the port: LISTEN_ADDR may name a host too (127.0.0.1:8080)
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 1
	}
	resp, err := c.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil || resp.StatusCode != 200 {
		return 1
	}
	return 0
}

// version is set at build time (-ldflags "-X main.version=1.0.0"); "dev" for local builds.
var version = "dev"

func main() {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println("Cipherfilm", version)
		return
	}
	// `cipherfilm` on its own, typed in the container's console, lists the commands instead of starting a second
	// server next to the running one; the image starts the server as /app
	if len(os.Args) > 1 && (os.Args[1] == "help" || os.Args[1] == "--help" || os.Args[1] == "-h") || (len(os.Args) == 1 && filepath.Base(os.Args[0]) == "cipherfilm") {
		printHelp(os.Stdout)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(addr))
	}
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "/data"
	}
	if len(os.Args) > 1 {
		if err := notRootOnTheirData(dataDir); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		switch os.Args[1] {
		case "backup":
			if err := runBackup(dataDir); err != nil {
				log.Fatal(err)
			}
			return
		case "backup-report": // the operator's backup tool reports its outcome for Admin > Server
			if err := runBackupReport(dataDir, os.Args[2:]); err != nil {
				log.Fatal(err)
			}
			return
		case "after-restore": // scripts/restore.sh, before the restored app starts
			if err := runAfterRestore(dataDir); err != nil {
				log.Fatal(err)
			}
			return
		case "revoke-sessions": // run after restoring an older backup: sessions it revived must not stay valid
			db, err := openDB(filepath.Join(dataDir, "app.db"))
			if err != nil {
				log.Fatal(err)
			}
			res, err := db.Exec(`DELETE FROM sessions`)
			if err != nil {
				log.Fatal(err)
			}
			n, _ := res.RowsAffected()
			fmt.Printf("revoked %d sessions\n", n)
			return
		case "check":
			r, err := runCheck(dataDir)
			if err != nil {
				log.Fatal(err)
			}
			printCheck(r)
			if r.Integrity != "ok" || len(r.MissingBlobs) > 0 {
				os.Exit(1)
			}
			return
		default:
			if found, err := runCLI(dataDir, os.Args[1], os.Args[2:], os.Stdout); found {
				if err != nil {
					fmt.Fprintln(os.Stderr, err)
					os.Exit(1)
				}
				return
			}
			// a script's command this version doesn't know must fail, not quietly start a second server on the data
			fmt.Fprintf(os.Stderr, "unknown command %q (version %s); cipherfilm help lists them\n", os.Args[1], version)
			os.Exit(2)
		}
	}
	// the port first: a second start next to a running server (`/app` typed in its console) stops here, before it
	// touches the data (setup token, the janitor's cleanup of uploads in progress)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("can't listen on %s: %v. Is Cipherfilm already running here? Its commands: cipherfilm help", addr, err)
	}
	app, err := newApp(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	if os.Getenv("TRUST_PROXY") == "1" && !app.trustProxy {
		log.Printf("TRUST_PROXY=1 is ignored until PUBLIC_HOSTS is set: login limits count the proxy's address")
	}
	if n := len(app.demo); n > 0 {
		log.Printf("DEMO_ACCOUNTS: %d read-only public demo account(s)", n)
	}
	csp = buildCSP(app.mapConf.origins())
	if err := app.initSetup(); err != nil {
		log.Fatal(err)
	}
	go app.janitor()
	srv := &http.Server{
		Addr:              addr,
		Handler:           app.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10, // the apps send a few small headers; Go's default is 1 MB
	}
	log.Printf("listening on %s", addr)
	log.Fatal(srv.Serve(ln))
}

// notRootOnTheirData refuses a server command run as root on data the server owns as another user (a console
// opened as root, `docker exec -u root`): files it creates (backup/, backup.lock, the database's -wal and -shm)
// would belong to root, and the server couldn't open them any more. Where the server itself runs as root, so does this.
func notRootOnTheirData(dataDir string) error {
	if os.Geteuid() != 0 {
		return nil
	}
	fi, err := os.Stat(dataDir)
	if err != nil {
		return nil
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && st.Uid != 0 {
		return fmt.Errorf("this is running as root, but %s belongs to user %d: files it creates would lock the server out.\n"+
			"Run it as the server's user: in Portainer leave the console's User field empty; with docker, leave out -u root", dataDir, st.Uid)
	}
	return nil
}
