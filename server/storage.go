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
	ID       string `json:"id"`
	Device   string `json:"device"`
	LastSeen int64  `json:"last_seen"`
	// last_seen is only the day (its UTC midnight): what an admin sees of another person's devices
	SeenDayOnly  bool  `json:"last_seen_day_only,omitempty"`
	LastUploadAt int64 `json:"last_upload_at"` // 0: none recorded (the server notes it since the overview came)
	AutoBackup   bool  `json:"auto_backup"`
	Stale        bool  `json:"backup_stale"`
	Current      bool  `json:"current,omitempty"`
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
	// all counters kept up to date by triggers (usage.go): one row, whatever the size of the library
	a.db.QueryRow(`SELECT quota_bytes, used_bytes, split_photos, split_videos, split_other, split_aux, ready_items FROM users WHERE id=?`, u.ID).
		Scan(&out.QuotaBytes, &out.UsedBytes, &out.Split.Photos, &out.Split.Videos, &out.Split.Other, &out.Split.Thumbs, &out.ItemCount)
	out.Unlimited = out.QuotaBytes == 0
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
		if x.ID != u.ID {
			// of another person's devices an admin learns on which day each was last used, not when: enough to see
			// one that is no longer used. backup_stale is already worked out from the exact time.
			for i := range acc.Devices {
				acc.Devices[i].LastSeen -= acc.Devices[i].LastSeen % 86400
				acc.Devices[i].SeenDayOnly = true
			}
		}
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
