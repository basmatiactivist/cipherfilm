package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const (
	settingDefaultQuota = "default_quota_bytes"
	auditKeep           = 500

	// what the nightly off-site backup (scripts/kopia-snapshot.sh) last reported, shown under Admin > Server
	settingBackupOKAt     = "backup_ok_at"
	settingBackupFailedAt = "backup_failed_at"
	settingBackupFailedIn = "backup_failed_in" // which step: "snapshot" or "upload"
)

// backupFailSteps are the steps a failure can be reported for. Only these fixed words are stored: never a tool's
// own error output, which can contain addresses or user names of the backup target.
var backupFailSteps = map[string]bool{"snapshot": true, "upload": true}

// runBackupReport records the outcome of an off-site backup run: "ok", or "failed <step>".
func runBackupReport(dataDir string, args []string) error {
	ok := len(args) == 1 && args[0] == "ok"
	failed := len(args) == 2 && args[0] == "failed" && backupFailSteps[args[1]]
	if !ok && !failed {
		return fmt.Errorf("usage: backup-report ok | backup-report failed snapshot|upload")
	}
	db, err := openDB(filepath.Join(dataDir, "app.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	now := strconv.FormatInt(time.Now().Unix(), 10)
	set := func(k, v string) error {
		_, err := db.Exec(`INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, v)
		return err
	}
	if ok {
		return set(settingBackupOKAt, now)
	}
	if err := set(settingBackupFailedAt, now); err != nil {
		return err
	}
	return set(settingBackupFailedIn, args[1])
}

func (a *App) setting(key string) string {
	var v string
	a.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	return v
}

func (a *App) settingInt(key string) int64 {
	n, _ := strconv.ParseInt(a.setting(key), 10, 64)
	return n
}

var startedAt = time.Now()

// defaultQuota is the storage limit new people get unless the invite says otherwise.
func (a *App) defaultQuota() int64 {
	var v string
	if a.db.QueryRow(`SELECT value FROM settings WHERE key=?`, settingDefaultQuota).Scan(&v) == nil {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
			return n
		}
	}
	return defaultUserQuota
}

// inviteQuota resolves an invite's stored limit: NULL means "use the default at the time the person joins". The
// default is read by the caller before it opens a transaction: reading it inside one would need a second pooled connection.
func inviteQuota(q sql.NullInt64, def int64) int64 {
	if q.Valid {
		return q.Int64
	}
	return def
}

// audit records an administrative event: who did what to whom. Metadata only, never content.
func (a *App) audit(actor, action, target, detail string) {
	a.db.Exec(`INSERT INTO audit_log(at,actor,action,target,detail) VALUES (?,?,?,?,?)`, a.now().Unix(), actor, action, target, detail)
	a.db.Exec(`DELETE FROM audit_log WHERE id <= (SELECT MAX(id) FROM audit_log) - ?`, auditKeep)
}

type settingsReq struct {
	DefaultQuotaBytes *int64 `json:"default_quota_bytes"` // 0 = unlimited
}

func (a *App) adminPatchSettings(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req settingsReq
	if !readJSON(w, r, &req) {
		return
	}
	if req.DefaultQuotaBytes == nil || *req.DefaultQuotaBytes < 0 || *req.DefaultQuotaBytes > 1<<50 {
		fail(w, 400, "invalid request")
		return
	}
	if _, err := a.db.Exec(`INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		settingDefaultQuota, strconv.FormatInt(*req.DefaultQuotaBytes, 10)); err != nil {
		fail(w, 500, "server error")
		return
	}
	a.audit(u.Email, "default limit changed", "", strconv.FormatInt(*req.DefaultQuotaBytes, 10))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) adminAudit(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	rows, err := a.db.Query(`SELECT at,actor,action,target,detail FROM audit_log ORDER BY id DESC LIMIT 100`)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var at int64
		var actor, action, target, detail string
		if rows.Scan(&at, &actor, &action, &target, &detail) == nil {
			out = append(out, map[string]any{"at": at, "actor": actor, "action": action, "target": target, "detail": detail})
		}
	}
	writeJSON(w, 200, map[string]any{"entries": out})
}

func dirSize(root string) int64 {
	var n int64
	filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err == nil && info.Mode().IsRegular() {
			n += info.Size()
		}
		return nil
	})
	return n
}

// adminStatus reports the health of the server itself: disk, data size, sessions, last backup.
func (a *App) adminStatus(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var st syscall.Statfs_t
	var free, total uint64
	if syscall.Statfs(a.dataDir, &st) == nil {
		free = uint64(st.Bavail) * uint64(st.Bsize)
		total = uint64(st.Blocks) * uint64(st.Bsize)
	}
	var sessions int
	a.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE expires_at > ?`, a.now().Unix()).Scan(&sessions)
	var lastBackup int64
	if fi, err := os.Stat(filepath.Join(a.dataDir, "backup")); err == nil {
		lastBackup = fi.ModTime().Unix()
	}
	writeJSON(w, 200, map[string]any{
		"disk_free_bytes": free, "disk_total_bytes": total,
		"data_bytes": dirSize(a.dataDir), "active_sessions": sessions,
		"last_backup_at": lastBackup, "uptime_seconds": int64(time.Since(startedAt).Seconds()),
		"default_quota_bytes": a.defaultQuota(), "version": version,
		"backup_ok_at": a.settingInt(settingBackupOKAt), "backup_failed_at": a.settingInt(settingBackupFailedAt),
		"backup_failed_in": a.setting(settingBackupFailedIn),
	})
}
