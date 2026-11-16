package main

import (
	"net/http"
	"strings"
	"syscall"
)

// The storage and backup overview (Account › Storage for each person, Admin › Storage for every account): how much an
// account takes and of what kind, and per signed-in device when it last uploaded. Everything here is what the server
// knows anyway to store the files and enforce the limit: sizes, the kind each item was uploaded as (photo, video,
// other), counts, device labels and times. Never anything about what a photo shows, its name, date or place: those
// are encrypted (docs/THREAT_MODEL.md, "What the server knows").

const (
	// a phone that is still used but hasn't uploaded for this long probably has automatic backup off or stuck
	backupStaleAfter = 7 * 24 * 3600
	// "still used": seen within this long
	backupSeenWithin = 2 * 24 * 3600
)

// storageRoutes are the person's own overview; the admin's is registered with the other admin routes.
func (a *App) storageRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/me/storage", a.auth(false, a.myStorage))
}

// markUploaded records that this session finished an upload (finalize). Only the time of the newest one is kept, per
// session, not which items it uploaded.
func (a *App) markUploaded(s *session) {
	a.db.Exec(`UPDATE sessions SET last_upload_at=? WHERE id_hash=?`, a.now().Unix(), s.IDHash)
}

// autoBackupDevice: a device whose app backs up on its own, so a long gap in its uploads while it is used says the
// backup may have stopped. The label is the app's own (X-CF-Device); it decides only whether a hint is shown.
func autoBackupDevice(label string) bool { return strings.HasSuffix(label, "(Android app)") }

type storageSplit struct {
	Photos int64 `json:"photos"`
	Videos int64 `json:"videos"`
	Other  int64 `json:"other"`
	Thumbs int64 `json:"thumbs"` // thumbnails and previews
	Index  int64 `json:"index"`  // search index entries and the account's encrypted documents (people, settings)
}

type storageDevice struct {
	ID           string `json:"id"`
	Device       string `json:"device"`
	LastSeen     int64  `json:"last_seen"`
	LastUploadAt int64  `json:"last_upload_at"` // 0: none recorded (the server notes it since the overview came)
	AutoBackup   bool   `json:"auto_backup"`
	Stale        bool   `json:"backup_stale"`
	Current      bool   `json:"current,omitempty"`
}

type accountStorage struct {
	ID         string          `json:"id"`
	Email      string          `json:"email"`
	Role       string          `json:"role"`
	Status     string          `json:"status"`
	QuotaBytes int64           `json:"quota_bytes"`
	Unlimited  bool            `json:"unlimited"`
	UsedBytes  int64           `json:"used_bytes"`
	ItemCount  int64           `json:"item_count"`
	Split      storageSplit    `json:"split"`
	Devices    []storageDevice `json:"devices"`
	// a public demo account is shared by strangers: their devices are not listed (to an admin, or to each other)
	DevicesHidden bool `json:"devices_hidden,omitempty"`
}

// storageOf builds one account's overview. onlyDevice, when not "", limits the device list to that session (a demo
// account looking at itself); hideDevices leaves it empty.
func (a *App) storageOf(u *user, current, onlyDevice string, hideDevices bool) accountStorage {
	out := accountStorage{ID: u.ID, Email: u.Email, Role: u.Role, Status: u.Status, Devices: []storageDevice{}, DevicesHidden: hideDevices}
	a.db.QueryRow(`SELECT quota_bytes, used_bytes FROM users WHERE id=?`, u.ID).Scan(&out.QuotaBytes, &out.UsedBytes)
	out.Unlimited = out.QuotaBytes == 0
	a.db.QueryRow(`SELECT COUNT(*) FROM items WHERE user_id=? AND state='ready'`, u.ID).Scan(&out.ItemCount)
	// stored_bytes holds an item's files including its thumbnail and preview (thumb_bytes, preview_bytes): the rest is
	// the original. Items finished before those two columns existed have 0 there, so their small files count as the
	// original: the split is close, the total exact (it is the same counter the limit uses).
	// A finished item's charge also has the disk blocks its files fill up (blockSlack), so the thumbnail and preview
	// count with theirs.
	aux := `MIN(stored_bytes, thumb_bytes+(?1-thumb_bytes%?1)%?1 + preview_bytes+(?1-preview_bytes%?1)%?1)`
	if rows, err := a.db.Query(`SELECT kind, COALESCE(SUM(stored_bytes-`+aux+`),0), COALESCE(SUM(`+aux+`),0)
		FROM items WHERE user_id=?2 GROUP BY kind`, diskBlock, u.ID); err == nil {
		for rows.Next() {
			var kind string
			var orig, aux int64
			if rows.Scan(&kind, &orig, &aux) != nil {
				continue
			}
			switch kind {
			case "image":
				out.Split.Photos += orig
			case "video":
				out.Split.Videos += orig
			default:
				out.Split.Other += orig
			}
			out.Split.Thumbs += aux
		}
		rows.Close()
	}
	out.Split.Index = max(0, out.UsedBytes-out.Split.Photos-out.Split.Videos-out.Split.Other-out.Split.Thumbs)
	if hideDevices {
		return out
	}
	now := a.now().Unix()
	rows, err := a.db.Query(`SELECT pub,device,last_seen,last_upload_at FROM sessions WHERE user_id=? AND expires_at>=? AND (?='' OR pub=?) ORDER BY last_seen DESC`,
		u.ID, now, onlyDevice, onlyDevice)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var d storageDevice
		if rows.Scan(&d.ID, &d.Device, &d.LastSeen, &d.LastUploadAt) != nil {
			continue
		}
		d.AutoBackup = autoBackupDevice(d.Device)
		d.Stale = backupStale(d, now)
		d.Current = d.ID == current
		out.Devices = append(out.Devices, d)
	}
	return out
}

// backupStale: a phone app that has uploaded before, hasn't for a week, and is still in use. A phone that only had
// nothing new to back up looks the same, so the apps say "seems".
func backupStale(d storageDevice, now int64) bool {
	return d.AutoBackup && d.LastUploadAt > 0 && now-d.LastUploadAt > backupStaleAfter && now-d.LastSeen < backupSeenWithin
}

func (a *App) myStorage(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	only := ""
	if a.isDemo(u) {
		only = s.Pub // as in the device list: strangers on the demo login see only their own device
	}
	writeJSON(w, 200, a.storageOf(u, s.Pub, only, false))
}

func diskSpace(dir string) (free, total uint64) {
	var st syscall.Statfs_t
	if syscall.Statfs(dir, &st) == nil {
		free = uint64(st.Bavail) * uint64(st.Bsize)
		total = uint64(st.Blocks) * uint64(st.Bsize)
	}
	return
}

// adminStorage is every account's overview plus the server's totals and its free disk space.
func (a *App) adminStorage(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	rows, err := a.db.Query(`SELECT id FROM users ORDER BY created_at`)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	accounts := []accountStorage{}
	var used, items, stale int64
	for _, id := range ids {
		x, err := a.userByID(id)
		if err != nil {
			continue
		}
		acc := a.storageOf(x, s.Pub, "", a.isDemo(x))
		used += acc.UsedBytes
		items += acc.ItemCount
		for _, d := range acc.Devices {
			if d.Stale {
				stale++
			}
		}
		accounts = append(accounts, acc)
	}
	free, total := diskSpace(a.dataDir)
	writeJSON(w, 200, map[string]any{"accounts": accounts, "used_bytes": used, "item_count": items, "stale_devices": stale,
		"disk_free_bytes": free, "disk_total_bytes": total})
}
