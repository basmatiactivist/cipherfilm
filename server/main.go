package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed all:static
var staticFS embed.FS

const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
	"img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; " +
	"manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

// The HEIC decoder (libheif, built with embind) needs eval. It runs in a dedicated worker served from /heic/,
// which gets a CSP that allows eval but forbids every network request, so it cannot send anything anywhere.
const cspHeic = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'none'; " +
	"worker-src 'none'; child-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		if strings.HasPrefix(r.URL.Path, "/heic/") {
			h.Set("Content-Security-Policy", cspHeic)
		} else {
			h.Set("Content-Security-Policy", csp)
		}
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
		h.Set("Strict-Transport-Security", "max-age=31536000")
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
	resp, err := c.Get("http://127.0.0.1" + addr + "/healthz")
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
	if len(os.Args) > 1 && (os.Args[1] == "help" || os.Args[1] == "--help" || os.Args[1] == "-h") {
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
		switch os.Args[1] {
		case "backup":
			if err := runBackup(dataDir); err != nil {
				log.Fatal(err)
			}
			return
		case "backup-report": // the nightly off-site backup reports its outcome for Admin > Server
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
			fmt.Fprintf(os.Stderr, "unknown command %q (version %s); /app help lists them\n", os.Args[1], version)
			os.Exit(2)
		}
	}
	app, err := newApp(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	if err := app.initSetup(); err != nil {
		log.Fatal(err)
	}
	go app.janitor()
	srv := &http.Server{
		Addr:              addr,
		Handler:           app.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("listening on %s", addr)
	log.Fatal(srv.ListenAndServe())
}
