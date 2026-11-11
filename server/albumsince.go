package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
)

// Incremental albums: GET /api/albums?since=<cursor> answers with the albums that changed after the cursor (each
// whole: its encrypted name and its current item ids) and the ids of those deleted, instead of every album again.
// Like the library's list (since.go), every change to what the album list shows takes the account's next number,
// users.albums_rev, stored in albums.rev, and a deleted album leaves a tombstone. What changes an album: created,
// renamed, a photo added or taken out, and a photo of it trashed, restored or purged (the list shows only photos in
// the library). Triggers do it in the same transaction as the change. The cursor is "<epoch>.<n>" with the epoch of
// the library's cursors; one below users.album_tomb_floor, from another epoch or ahead of the account gets "reset".

const albumSyncSchema = `
CREATE TABLE IF NOT EXISTS album_tombstones (
  user_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  album_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, rev, album_id)
);
CREATE INDEX IF NOT EXISTS album_tombstones_at ON album_tombstones(at);
CREATE INDEX IF NOT EXISTS albums_rev ON albums(user_id, rev);
CREATE INDEX IF NOT EXISTS album_items_item ON album_items(item_id);
`

// bumpAlbums gives the albums the SQL condition selects (it may use NEW/OLD) the account's next number; uid is the
// account's id as SQL.
func bumpAlbums(uid, where string) string {
	return fmt.Sprintf(`UPDATE users SET albums_rev=albums_rev+1 WHERE id=%s;
  UPDATE albums SET rev=(SELECT albums_rev FROM users WHERE id=%s) WHERE user_id=%s AND (%s);`, uid, uid, uid, where)
}

// Made anew at every start, like the library's triggers. A cascade from a deleted account finds no account row and
// writes nothing; album_tomb_user takes along what is left.
var albumSyncTriggers = []string{
	`DROP TRIGGER IF EXISTS albums_rev_ins`,
	`DROP TRIGGER IF EXISTS albums_rev_upd`,
	`DROP TRIGGER IF EXISTS albums_rev_del`,
	`DROP TRIGGER IF EXISTS album_items_rev_ins`,
	`DROP TRIGGER IF EXISTS album_items_rev_del`,
	`DROP TRIGGER IF EXISTS items_album_rev`,
	`DROP TRIGGER IF EXISTS album_tomb_user`,
	`CREATE TRIGGER albums_rev_ins AFTER INSERT ON albums BEGIN ` + bumpAlbums("NEW.user_id", "id=NEW.id") + ` END`,
	`CREATE TRIGGER albums_rev_upd AFTER UPDATE OF name_enc ON albums WHEN OLD.name_enc IS NOT NEW.name_enc BEGIN ` +
		bumpAlbums("NEW.user_id", "id=NEW.id") + ` END`,
	`CREATE TRIGGER albums_rev_del AFTER DELETE ON albums
BEGIN
  UPDATE users SET albums_rev=albums_rev+1 WHERE id=OLD.user_id;
  INSERT INTO album_tombstones(user_id,rev,album_id,at) SELECT id, albums_rev, OLD.id, CAST(strftime('%s','now') AS INTEGER) FROM users WHERE id=OLD.user_id;
END`,
	// membership; a cascade from a deleted album finds no album row and changes nothing
	`CREATE TRIGGER album_items_rev_ins AFTER INSERT ON album_items BEGIN ` +
		bumpAlbums("(SELECT user_id FROM albums WHERE id=NEW.album_id)", "id=NEW.album_id") + ` END`,
	`CREATE TRIGGER album_items_rev_del AFTER DELETE ON album_items BEGIN ` +
		bumpAlbums("(SELECT user_id FROM albums WHERE id=OLD.album_id)", "id=OLD.album_id") + ` END`,
	// a photo trashed, restored or finished: the albums it is in show it or not (a purge cascades to album_items)
	`CREATE TRIGGER items_album_rev AFTER UPDATE OF state,trashed_at ON items
WHEN (OLD.state IS NOT NEW.state OR OLD.trashed_at IS NOT NEW.trashed_at) AND EXISTS (SELECT 1 FROM album_items WHERE item_id=NEW.id)
BEGIN ` + bumpAlbums("NEW.user_id", "id IN (SELECT album_id FROM album_items WHERE item_id=NEW.id)") + ` END`,
	`CREATE TRIGGER album_tomb_user AFTER DELETE ON users BEGIN DELETE FROM album_tombstones WHERE user_id=OLD.id; END`,
}

// migrateAlbumSync adds albums.rev, users.albums_rev and users.album_tomb_floor, the tombstones and the triggers.
// Albums from before keep rev 0: a client gets them with its first whole list.
func migrateAlbumSync(db *sql.DB) error {
	acols, err := tableCols(db, "albums")
	if err != nil {
		return err
	}
	if !acols["rev"] {
		if _, err := db.Exec(`ALTER TABLE albums ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}
	ucols, err := tableCols(db, "users")
	if err != nil {
		return err
	}
	for _, col := range []string{"albums_rev", "album_tomb_floor"} {
		if !ucols[col] {
			if _, err := db.Exec(`ALTER TABLE users ADD COLUMN ` + col + ` INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
		}
	}
	if _, err := db.Exec(albumSyncSchema); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range albumSyncTriggers {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (a *App) albumSyncState(userID string) (syncState, error) {
	var s syncState
	err := a.db.QueryRow(`SELECT u.albums_rev, u.album_tomb_floor, COALESCE((SELECT value FROM settings WHERE key='sync_epoch'),'') FROM users u WHERE u.id=?`, userID).
		Scan(&s.rev, &s.floor, &s.epoch)
	return s, err
}

type albumOut struct {
	ID      string   `json:"id"`
	NameEnc string   `json:"name_enc"`
	Created int64    `json:"created_at"`
	ItemIDs []string `json:"item_ids"`
}

// albumsOf reads the account's albums (all of them, or those changed in (since, upto]) with the photos in each that
// are in the library, in the order they were added.
func (a *App) albumsOf(userID string, changed bool, since, upto int64) ([]*albumOut, error) {
	q, args := `SELECT id,name_enc,created_at FROM albums WHERE user_id=?`, []any{userID}
	if changed {
		q += ` AND rev>? AND rev<=?`
		args = append(args, since, upto)
	}
	rows, err := a.db.Query(q+` ORDER BY created_at, id`, args...)
	if err != nil {
		return nil, err
	}
	list := []*albumOut{}
	byID := map[string]*albumOut{}
	for rows.Next() {
		x := &albumOut{ItemIDs: []string{}}
		if rows.Scan(&x.ID, &x.NameEnc, &x.Created) == nil {
			list = append(list, x)
			byID[x.ID] = x
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return list, nil
	}
	mq := `SELECT ai.album_id, ai.item_id FROM album_items ai JOIN albums al ON al.id=ai.album_id JOIN items it ON it.id=ai.item_id
		WHERE al.user_id=? AND it.state='ready' AND it.trashed_at IS NULL`
	margs := []any{userID}
	if changed {
		mq += ` AND al.id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(list)), ",") + `)`
		for _, x := range list {
			margs = append(margs, x.ID)
		}
	}
	mem, err := a.db.Query(mq+` ORDER BY ai.added_at, ai.item_id`, margs...)
	if err != nil {
		return nil, err
	}
	defer mem.Close()
	for mem.Next() {
		var aid, iid string
		if mem.Scan(&aid, &iid) == nil && byID[aid] != nil {
			byID[aid].ItemIDs = append(byID[aid].ItemIDs, iid)
		}
	}
	return list, mem.Err()
}

// albumsSince answers ?since: the albums changed after the cursor, whole, and those deleted. An account has at most
// maxAlbumsPerUser albums, so it all fits one answer ("more" is always false).
func (a *App) albumsSince(w http.ResponseWriter, r *http.Request, u *user) {
	epoch, since, _, ok := sinceParam(r)
	if !ok {
		fail(w, 400, "invalid request")
		return
	}
	st, err := a.albumSyncState(u.ID)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	out := map[string]any{"albums": []*albumOut{}, "removed": []string{}, "cursor": st.cursor(st.rev), "more": false, "reset": false}
	if epoch != st.epoch || since > st.rev || since < st.floor {
		out["reset"] = true
		writeJSON(w, 200, out)
		return
	}
	// bounded above by the number read first: a change committed meanwhile comes with the next request
	list, err := a.albumsOf(u.ID, true, since, st.rev)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	trows, err := a.db.Query(`SELECT DISTINCT album_id FROM album_tombstones WHERE user_id=? AND rev>? AND rev<=?`, u.ID, since, st.rev)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	removed := []string{}
	for trows.Next() {
		var id string
		if trows.Scan(&id) == nil {
			removed = append(removed, id)
		}
	}
	trows.Close()
	if err := trows.Err(); err != nil {
		fail(w, 500, "server error")
		return
	}
	out["albums"], out["removed"] = list, removed
	writeJSON(w, 200, out)
}

// pruneAlbumTombstones drops album tombstones older than tombRetention, like pruneTombstones for items.
func (a *App) pruneAlbumTombstones() {
	cutoff := a.now().Add(-tombRetention).Unix()
	tx, err := a.db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE users SET album_tomb_floor=MAX(album_tomb_floor, (SELECT MAX(rev) FROM album_tombstones t WHERE t.user_id=users.id AND t.at<?))
		WHERE id IN (SELECT user_id FROM album_tombstones WHERE at<?)`, cutoff, cutoff); err != nil {
		return
	}
	if _, err := tx.Exec(`DELETE FROM album_tombstones WHERE at<?`, cutoff); err != nil {
		return
	}
	tx.Commit()
}
