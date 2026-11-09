package main

import (
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

// Server commands for whoever runs the container, like Immich's (docs/SERVER-COMMANDS.md):
//
//	docker compose exec app /app list-users
//
// They work on the same database as the running server (SQLite allows that) and are written to the audit log as
// "server console". What no command can do is reset a password: the password unlocks the person's keys, and the
// server has neither. Only the person's recovery key can (Sign in › Forgot password).

const consoleActor = "server console"

type cliCmd struct {
	name, args, help string
	run              func(a *App, out io.Writer, args []string) error
}

var cliCmds []cliCmd

func init() {
	cliCmds = []cliCmd{
		{"status", "", "version, accounts, photos, storage, signed-in devices and the last backup", cliStatus},
		{"list-users", "", "every account: role, status, photos, storage used and limit, last sign-in", cliListUsers},
		{"make-admin", "EMAIL", "make the account an administrator (no storage limit)", cliRole("admin")},
		{"revoke-admin", "EMAIL", "make an administrator a regular user (default limit); one must remain", cliRole("user")},
		{"disable-user", "EMAIL", "lock the account and sign out its devices; nothing is deleted", cliStatusTo("disabled")},
		{"enable-user", "EMAIL", "unlock the account", cliStatusTo("active")},
		{"delete-user", "EMAIL --yes", "permanently delete the account with its photos, albums and search data", cliDeleteUser},
		{"set-quota", "EMAIL GB", "set the storage limit: a number of GB, unlimited or default", cliSetQuota},
		{"allow-explicit", "EMAIL", "allow explicit search for the account (docs/SEARCH.md)", cliExplicit(true)},
		{"deny-explicit", "EMAIL", "turn explicit search off for the account", cliExplicit(false)},
		{"list-sessions", "[EMAIL]", "signed-in devices: account, device, signed in, last active, indexer", cliListSessions},
		{"sign-out", "EMAIL [--wipe]", "sign out all the account's devices; --wipe also deletes their local copy of the library", cliSignOut},
		{"invite", "EMAIL [--quota GB] [--url URL]", "make an invite link (valid 7 days); URL is your Cipherfilm address", cliInvite},
		{"reset-password", "EMAIL", "why this isn't possible, and what to do instead", cliResetPassword},
	}
}

// runCLI runs a command from cliCmds; false if there is no such command.
func runCLI(dataDir, name string, args []string, out io.Writer) (bool, error) {
	for _, c := range cliCmds {
		if c.name != name {
			continue
		}
		a, err := newApp(dataDir)
		if err != nil {
			return true, err
		}
		defer a.db.Close()
		return true, c.run(a, out, args)
	}
	return false, nil
}

func printHelp(out io.Writer) {
	fmt.Fprintf(out, "Cipherfilm %s: server commands\n\nUsage: docker compose exec app /app COMMAND [ARGS]\n\n", version)
	tw := tabwriter.NewWriter(out, 2, 4, 2, ' ', 0)
	for _, c := range cliCmds {
		fmt.Fprintf(tw, "  %s %s\t%s\n", c.name, c.args, c.help)
	}
	for _, c := range [][2]string{
		{"backup", "write a database snapshot to /data/backup"},
		{"backup-report ok | failed snapshot|upload", "record a backup tool's result, shown under Admin > Server"},
		{"check", "check the database and that every stored file exists"},
		{"revoke-sessions", "sign out every device of every account (after restoring a backup)"},
		{"version", "print the version"},
		{"help", "this list"},
	} {
		fmt.Fprintf(tw, "  %s\t%s\n", c[0], c[1])
	}
	tw.Flush()
}

// ---- helpers ----

func cliUser(a *App, args []string) (*user, error) {
	if len(args) < 1 {
		return nil, errors.New("give the account's e-mail address")
	}
	email, ok := normEmail(args[0])
	if !ok {
		return nil, fmt.Errorf("%q is not an e-mail address", args[0])
	}
	u, err := a.userByEmail(email)
	if err != nil {
		return nil, fmt.Errorf("no account with the e-mail %s", email)
	}
	return u, nil
}

func hasFlag(args []string, f string) bool {
	for _, x := range args {
		if x == f {
			return true
		}
	}
	return false
}

func flagValue(args []string, f string) (string, bool) {
	for i, x := range args {
		if x == f && i+1 < len(args) {
			return args[i+1], true
		}
		if v, ok := strings.CutPrefix(x, f+"="); ok {
			return v, true
		}
	}
	return "", false
}

// lastAdmin: removing this account's admin rights (or the account) would leave no active administrator.
func lastAdmin(a *App, u *user) bool {
	if u.Role != "admin" || u.Status != "active" {
		return false
	}
	var others int
	a.db.QueryRow(`SELECT COUNT(*) FROM users WHERE role='admin' AND status='active' AND id<>?`, u.ID).Scan(&others)
	return others == 0
}

func gb(n int64) string {
	switch {
	case n >= 1e9:
		return strconv.FormatFloat(float64(n)/1e9, 'f', 1, 64) + " GB"
	case n >= 1e6:
		return strconv.FormatInt(n/1e6, 10) + " MB"
	case n > 0:
		return "<1 MB"
	}
	return "0"
}

func when(sec int64) string {
	if sec <= 0 {
		return "never"
	}
	return time.Unix(sec, 0).Local().Format("2006-01-02 15:04")
}

// parseQuota reads "20" / "20GB" / "1.5 GB" as bytes; "unlimited" (or 0) is no limit.
func parseQuota(s string) (int64, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "unlimited" || s == "none" {
		return 0, nil
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(s, "gb")), 64)
	if err != nil || f < 0 || f > 1e6 || math.IsNaN(f) {
		return 0, fmt.Errorf("%q is not a size in GB (for example 50, or unlimited)", s)
	}
	return int64(f * 1e9), nil
}

// ---- commands ----

func cliStatus(a *App, out io.Writer, _ []string) error {
	var users, admins, disabled, items, trash, sessions int
	var stored int64
	a.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(role='admin'),0), COALESCE(SUM(status='disabled'),0) FROM users`).Scan(&users, &admins, &disabled)
	a.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(trashed_at IS NOT NULL),0), COALESCE(SUM(stored_bytes),0) FROM items WHERE state='ready'`).Scan(&items, &trash, &stored)
	a.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE expires_at > ?`, a.now().Unix()).Scan(&sessions)
	last := int64(0)
	if fi, err := os.Stat(filepath.Join(a.dataDir, "backup")); err == nil {
		last = fi.ModTime().Unix()
	}
	tw := tabwriter.NewWriter(out, 2, 4, 2, ' ', 0)
	fmt.Fprintf(tw, "Version\t%s\n", version)
	fmt.Fprintf(tw, "Accounts\t%d (%d admin, %d locked)\n", users, admins, disabled)
	fmt.Fprintf(tw, "Photos and videos\t%d (%d in the trash)\n", items, trash)
	fmt.Fprintf(tw, "Stored\t%s (encrypted, with thumbnails and previews)\n", gb(stored))
	fmt.Fprintf(tw, "Signed-in devices\t%d\n", sessions)
	fmt.Fprintf(tw, "Database snapshot\t%s\n", when(last))
	if t := a.settingInt(settingBackupOKAt); t > 0 {
		fmt.Fprintf(tw, "Off-site backup\tlast good %s\n", when(t))
	}
	if t := a.settingInt(settingBackupFailedAt); t > 0 {
		fmt.Fprintf(tw, "Off-site backup failed\t%s (%s)\n", when(t), a.setting(settingBackupFailedIn))
	}
	return tw.Flush()
}

func cliListUsers(a *App, out io.Writer, _ []string) error {
	rows, err := a.db.Query(`SELECT u.email, u.role, u.status, u.quota_bytes, u.last_login_at, u.nsfw,
		(SELECT COUNT(*) FROM items i WHERE i.user_id=u.id AND i.state='ready'),
		` + usedBytesSQL("u.id") + `
		FROM users u ORDER BY u.created_at`)
	if err != nil {
		return err
	}
	defer rows.Close()
	tw := tabwriter.NewWriter(out, 2, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "E-MAIL\tROLE\tSTATUS\tPHOTOS\tUSED\tLIMIT\tEXPLICIT\tLAST SIGN-IN")
	for rows.Next() {
		var email, role, status string
		var quota, last, used int64
		var nsfw bool
		var n int
		if rows.Scan(&email, &role, &status, &quota, &last, &nsfw, &n, &used) != nil {
			continue
		}
		limit := "unlimited"
		if quota > 0 {
			limit = gb(quota)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%d\t%s\t%s\t%s\t%s\n", email, role, status, n, gb(used), limit, map[bool]string{true: "allowed", false: "-"}[nsfw], when(last))
	}
	return tw.Flush()
}

func cliRole(role string) func(*App, io.Writer, []string) error {
	return func(a *App, out io.Writer, args []string) error {
		u, err := cliUser(a, args)
		if err != nil {
			return err
		}
		if u.Role == role {
			fmt.Fprintf(out, "%s is already %s\n", u.Email, map[string]string{"admin": "an administrator", "user": "a regular user"}[role])
			return nil
		}
		if role == "user" && lastAdmin(a, u) {
			return errors.New("this is the only active administrator: make someone else an administrator first")
		}
		q := int64(0) // admins have no limit; someone moved back to "user" gets the default
		if role == "user" {
			q = a.defaultQuota()
		}
		res, err := a.db.Exec(`UPDATE users SET role=?, quota_bytes=? WHERE id=? AND (?='admin' OR `+keepsAdmin+`)`, role, q, u.ID, role)
		if err != nil {
			return err
		}
		if rowsAffected(res, nil) != 1 {
			return errors.New("this is the only active administrator: make someone else an administrator first")
		}
		a.audit(consoleActor, "role changed", u.Email, role)
		fmt.Fprintf(out, "%s is now %s\n", u.Email, map[string]string{"admin": "an administrator", "user": "a regular user"}[role])
		return nil
	}
}

func cliStatusTo(status string) func(*App, io.Writer, []string) error {
	return func(a *App, out io.Writer, args []string) error {
		u, err := cliUser(a, args)
		if err != nil {
			return err
		}
		if status == "disabled" && lastAdmin(a, u) {
			return errors.New("this is the only active administrator: make someone else an administrator first")
		}
		res, err := a.db.Exec(`UPDATE users SET status=? WHERE id=? AND (?='active' OR `+keepsAdmin+`)`, status, u.ID, status)
		if err != nil {
			return err
		}
		if rowsAffected(res, nil) != 1 {
			return errors.New("this is the only active administrator: make someone else an administrator first")
		}
		if status == "disabled" {
			a.db.Exec(`DELETE FROM sessions WHERE user_id=?`, u.ID)
			a.audit(consoleActor, "disabled", u.Email, "")
			fmt.Fprintf(out, "%s is locked and signed out everywhere; its photos stay. Undo with enable-user.\n", u.Email)
			return nil
		}
		a.audit(consoleActor, "enabled", u.Email, "")
		fmt.Fprintf(out, "%s can sign in again\n", u.Email)
		return nil
	}
}

func cliDeleteUser(a *App, out io.Writer, args []string) error {
	u, err := cliUser(a, args)
	if err != nil {
		return err
	}
	if lastAdmin(a, u) {
		return errors.New("this is the only active administrator: make someone else an administrator first")
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM items WHERE user_id=?`, u.ID).Scan(&n)
	if !hasFlag(args, "--yes") {
		return fmt.Errorf("this permanently deletes %s and its %d photos and videos; nobody can bring them back.\nRun it again with --yes to confirm", u.Email, n)
	}
	ids := a.itemIDs(u.ID)
	res, err := a.db.Exec(`DELETE FROM users WHERE id=? AND `+keepsAdmin, u.ID)
	if rowsAffected(res, err) != 1 {
		return errors.New("couldn't delete the account (it may be the only active administrator)")
	}
	for _, id := range ids {
		a.removeBlobs(id)
	}
	forgetEmail(a.db, u.Email)
	a.audit(consoleActor, "deleted", u.Email, "")
	fmt.Fprintf(out, "deleted %s and %d photos and videos\n", u.Email, len(ids))
	return nil
}

func cliSetQuota(a *App, out io.Writer, args []string) error {
	u, err := cliUser(a, args)
	if err != nil {
		return err
	}
	if len(args) < 2 {
		return errors.New("give the limit in GB, unlimited or default")
	}
	var q int64
	if strings.EqualFold(args[1], "default") {
		q = a.defaultQuota()
	} else if q, err = parseQuota(strings.Join(args[1:], "")); err != nil {
		return err
	}
	if _, err := a.db.Exec(`UPDATE users SET quota_bytes=? WHERE id=?`, q, u.ID); err != nil {
		return err
	}
	a.audit(consoleActor, "storage limit changed", u.Email, strconv.FormatInt(q, 10))
	if q == 0 {
		fmt.Fprintf(out, "%s has no storage limit\n", u.Email)
	} else {
		fmt.Fprintf(out, "%s may store %s\n", u.Email, gb(q))
	}
	return nil
}

func cliExplicit(on bool) func(*App, io.Writer, []string) error {
	return func(a *App, out io.Writer, args []string) error {
		u, err := cliUser(a, args)
		if err != nil {
			return err
		}
		if _, err := a.db.Exec(`UPDATE users SET nsfw=? WHERE id=?`, on, u.ID); err != nil {
			return err
		}
		a.audit(consoleActor, map[bool]string{true: "explicit search allowed", false: "explicit search turned off"}[on], u.Email, "")
		fmt.Fprintf(out, "explicit search is %s for %s\n", map[bool]string{true: "allowed", false: "off"}[on], u.Email)
		return nil
	}
}

func cliListSessions(a *App, out io.Writer, args []string) error {
	q, qa := `SELECT u.email, s.device, s.created_at, s.last_seen, u.indexer = s.pub FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires_at > ?`, []any{a.now().Unix()}
	if len(args) > 0 {
		u, err := cliUser(a, args)
		if err != nil {
			return err
		}
		q, qa = q+` AND u.id=?`, append(qa, u.ID)
	}
	rows, err := a.db.Query(q+` ORDER BY u.email, s.last_seen DESC`, qa...)
	if err != nil {
		return err
	}
	defer rows.Close()
	tw := tabwriter.NewWriter(out, 2, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "E-MAIL\tDEVICE\tSIGNED IN\tLAST ACTIVE\tINDEXES")
	for rows.Next() {
		var email, device string
		var created, seen int64
		var indexer bool
		if rows.Scan(&email, &device, &created, &seen, &indexer) != nil {
			continue
		}
		if device == "" {
			device = "unknown device"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", email, device, when(created), when(seen), map[bool]string{true: "yes", false: ""}[indexer])
	}
	return tw.Flush()
}

func cliSignOut(a *App, out io.Writer, args []string) error {
	u, err := cliUser(a, args)
	if err != nil {
		return err
	}
	if hasFlag(args, "--wipe") { // the devices are told so and delete what they keep (sessions.go)
		a.remember(`user_id=?`, u.ID)
	}
	res, err := a.db.Exec(`DELETE FROM sessions WHERE user_id=?`, u.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	a.audit(consoleActor, "signed out every device", u.Email, map[bool]string{true: "and wiped", false: ""}[hasFlag(args, "--wipe")])
	fmt.Fprintf(out, "signed out %d devices of %s\n", n, u.Email)
	return nil
}

func cliInvite(a *App, out io.Writer, args []string) error {
	if len(args) < 1 {
		return errors.New("give the e-mail address to invite")
	}
	email, ok := normEmail(args[0])
	if !ok {
		return fmt.Errorf("%q is not an e-mail address", args[0])
	}
	if _, err := a.userByEmail(email); err == nil {
		return fmt.Errorf("%s already has an account", email)
	}
	var quota any // NULL = the default when the person joins
	if v, ok := flagValue(args, "--quota"); ok {
		q, err := parseQuota(v)
		if err != nil {
			return err
		}
		quota = q
	}
	tok := randToken()
	exp := a.now().Add(inviteTTL).Unix()
	a.db.Exec(`DELETE FROM invites WHERE email=? AND used_at IS NULL`, email)
	if _, err := a.db.Exec(`INSERT INTO invites(id,token_hash,email,created_by,created_at,expires_at,quota_bytes) VALUES (?,?,?,?,?,?,?)`,
		randID(), sha256hex(tok), email, consoleActor, a.now().Unix(), exp, quota); err != nil {
		return err
	}
	a.audit(consoleActor, "invited", email, "")
	path := "/invite/" + url.PathEscape(tok)
	base, ok := flagValue(args, "--url")
	if !ok {
		for h := range a.hosts { // PUBLIC_HOSTS, if set
			base = "https://" + h
			break
		}
	}
	if base == "" {
		fmt.Fprintf(out, "Invite for %s, valid until %s. Put your Cipherfilm address in front of this path (or pass --url https://photos.example.com):\n%s\n", email, when(exp), path)
		return nil
	}
	fmt.Fprintf(out, "Invite for %s, valid until %s:\n%s%s\n", email, when(exp), strings.TrimRight(base, "/"), path)
	return nil
}

func cliResetPassword(a *App, out io.Writer, args []string) error {
	fmt.Fprint(out, `The server can't reset a password, by design: the password unlocks the account's keys, and the server
has neither (end-to-end encryption, docs/CRYPTO.md). An administrator who could reset it could also read the photos.

Instead:
  - The person uses "Forgot password" with their recovery key (24 words) and sets a new password.
  - Without the recovery key nobody can open the photos. To start over:
      /app delete-user EMAIL --yes      (deletes the account and its photos permanently)
      /app invite EMAIL                 (a new account for the same address)
  - To only block sign-in: /app disable-user EMAIL, or /app sign-out EMAIL.
`)
	return nil
}
