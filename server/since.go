package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

// Incremental lists: GET /api/items?since=<cursor> (and /api/trash?since=) answer with what changed after the cursor
// instead of the whole list, so a live update (events.go) during a phone's 200-photo backup costs each other device a
// few records, not the whole library again.
//
// Every change to what a list shows (finalized, favorite, trashed, restored, purged) takes the account's next number,
// users.items_rev, and stores it in items.rev; a removed item leaves a tombstone with its number. Triggers do this in
// the same transaction as the change, so no code path can forget it, and SQLite's single writer makes the numbers
// commit in order: once a reader sees items_rev = n, every change up to n is visible to it. The cursor is
// "<epoch>.<n>"; the epoch is renewed when a backup is restored (the numbers go back with the database then).
//
// Tombstones are kept for tombRetention; users.tomb_floor remembers the newest one pruned. A cursor below it, from
// another epoch, or ahead of the account (a database put back by hand), gets "reset": the client loads the whole list.

const tombRetention = 30 * 24 * time.Hour

var cursorRe = regexp.MustCompile(`^([0-9a-f]{16})\.([0-9]{1,19})$`)

const syncSchema = `
CREATE TABLE IF NOT EXISTS item_tombstones (
  user_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, rev)
);
CREATE INDEX IF NOT EXISTS item_tombstones_at ON item_tombstones(at);
CREATE INDEX IF NOT EXISTS items_rev ON items(user_id, rev);
INSERT OR IGNORE INTO settings(key,value) VALUES ('sync_epoch', lower(hex(randomblob(8))));
`

// The triggers are made anew at every start, so a changed definition takes effect with the next version. They watch
// the columns whose change a list shows; has_thumb/has_preview only change while uploading, and a replaced thumbnail
// or preview of a finished item (where both stay 1) moves aux_ver on.
// No foreign key on item_tombstones: an account's deletion cascades to its items, whose trigger then finds no account
// row and writes nothing (a tombstone inserted mid-cascade could otherwise fail the deletion); items_tomb_user takes
// along what is left.
var syncTriggers = []string{
	`DROP TRIGGER IF EXISTS items_rev_upd`,
	`DROP TRIGGER IF EXISTS items_rev_del`,
	`DROP TRIGGER IF EXISTS items_tomb_user`,
	`CREATE TRIGGER items_rev_upd AFTER UPDATE OF state,wrapped_item_key,meta_enc,has_thumb,has_preview,aux_ver,favorite,trashed_at ON items
WHEN NEW.state='ready' AND (OLD.state IS NOT NEW.state OR OLD.wrapped_item_key IS NOT NEW.wrapped_item_key OR OLD.meta_enc IS NOT NEW.meta_enc
  OR OLD.has_thumb IS NOT NEW.has_thumb OR OLD.has_preview IS NOT NEW.has_preview OR OLD.aux_ver IS NOT NEW.aux_ver OR OLD.favorite IS NOT NEW.favorite OR OLD.trashed_at IS NOT NEW.trashed_at)
BEGIN
  UPDATE users SET items_rev=items_rev+1 WHERE id=NEW.user_id;
  UPDATE items SET rev=(SELECT items_rev FROM users WHERE id=NEW.user_id) WHERE id=NEW.id;
END`,
	// an unfinished upload was never in a list: its removal needs no tombstone
	`CREATE TRIGGER items_rev_del AFTER DELETE ON items WHEN OLD.state='ready'
BEGIN
  UPDATE users SET items_rev=items_rev+1 WHERE id=OLD.user_id;
  INSERT INTO item_tombstones(user_id,rev,item_id,at) SELECT id, items_rev, OLD.id, CAST(strftime('%s','now') AS INTEGER) FROM users WHERE id=OLD.user_id;
END`,
	`CREATE TRIGGER items_tomb_user AFTER DELETE ON users BEGIN DELETE FROM item_tombstones WHERE user_id=OLD.id; END`,
}

// migrateSync adds the change numbers (items.rev, users.items_rev, users.tomb_floor), the tombstones and the triggers.
// Items from before keep rev 0: a client gets them with its first whole list, as before.
func migrateSync(db *sql.DB) error {
	icols, err := tableCols(db, "items")
	if err != nil {
		return err
	}
	if !icols["rev"] {
		if _, err := db.Exec(`ALTER TABLE items ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}
	ucols, err := tableCols(db, "users")
	if err != nil {
		return err
	}
	for _, col := range []string{"items_rev", "tomb_floor"} {
		if !ucols[col] {
			if _, err := db.Exec(`ALTER TABLE users ADD COLUMN ` + col + ` INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
		}
	}
	if _, err := db.Exec(syncSchema); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range syncTriggers {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// syncState is where the account stands: read before the list itself, so the list holds at least everything up to rev.
type syncState struct {
	epoch      string
	rev, floor int64
}

func (a *App) syncState(userID string) (syncState, error) {
	var s syncState
	err := a.db.QueryRow(`SELECT u.items_rev, u.tomb_floor, COALESCE((SELECT value FROM settings WHERE key='sync_epoch'),'') FROM users u WHERE u.id=?`, userID).
		Scan(&s.rev, &s.floor, &s.epoch)
	return s, err
}

func (s syncState) cursor(rev int64) string { return fmt.Sprintf("%s.%d", s.epoch, rev) }

// sinceParam reads ?since; has is false without one (the whole list, or ?after paging, as before).
func sinceParam(r *http.Request) (epoch string, rev int64, has, ok bool) {
	v := r.URL.Query().Get("since")
	if v == "" {
		return "", 0, false, true
	}
	m := cursorRe.FindStringSubmatch(v)
	if m == nil {
		return "", 0, true, false
	}
	n, err := strconv.ParseInt(m[2], 10, 64)
	if err != nil {
		return "", 0, true, false
	}
	return m[1], n, true, true
}

// listSince answers ?since for the library (trash=false) or the trash. An item whose change took it out of the list
// (trashed, for the library; restored, for the trash) comes as removed, like a purged one. Changes are sent in the
// order of their numbers, at most a page at a time: "more" says to ask again with the new cursor.
func (a *App) listSince(w http.ResponseWriter, r *http.Request, u *user, trash bool, extra map[string]any) {
	epoch, since, _, ok := sinceParam(r)
	if !ok {
		fail(w, 400, "invalid request")
		return
	}
	st, err := a.syncState(u.ID)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	out := map[string]any{"items": []map[string]any{}, "removed": []string{}, "cursor": st.cursor(st.rev), "more": false, "reset": false}
	for k, v := range extra {
		out[k] = v
	}
	if epoch != st.epoch || since > st.rev || since < st.floor {
		out["reset"] = true
		writeJSON(w, 200, out)
		return
	}
	// bounded above by the number read first: a change committed meanwhile comes with the next request
	rows, err := a.db.Query(`SELECT rev,id,kind,size_bytes,segment_count,wrapped_item_key,meta_enc,has_thumb,has_preview,created_at,favorite,trashed_at
		FROM items WHERE user_id=? AND state='ready' AND rev>? AND rev<=? ORDER BY rev LIMIT ?`, u.ID, since, st.rev, listPage+1)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	type change struct {
		rev  int64
		id   string
		item map[string]any // nil: removed from this list
	}
	var changed []change
	// read only as many full rows as one page can carry: the byte budget applies while reading, not after
	held, cut := 0, int64(-1) // cut: rev of the last row read when the budget ended the reading
	for held < pageBytes && rows.Next() {
		var rev, size, count, created int64
		var id, kind, key, meta string
		var th, pv, fav bool
		var trashed sql.NullInt64
		if rows.Scan(&rev, &id, &kind, &size, &count, &key, &meta, &th, &pv, &created, &fav, &trashed) != nil {
			continue
		}
		c := change{rev: rev, id: id}
		if trashed.Valid == trash {
			c.item = map[string]any{"id": id, "kind": kind, "size": size, "segment_count": count, "wrapped_item_key": key, "meta_enc": meta, "has_thumb": th, "has_preview": pv, "created_at": created, "favorite": fav}
			if trash {
				c.item["trashed_at"] = trashed.Int64
				c.item["purge_at"] = trashed.Int64 + int64(trashRetention.Seconds())
			}
			held += len(key) + len(meta)
		}
		changed = append(changed, c)
		if held >= pageBytes {
			cut = rev
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		fail(w, 500, "server error")
		return
	}
	upto := st.rev
	if cut >= 0 {
		upto = cut // removals after the last row read wait for the next page, behind the items read up to there
	}
	trows, err := a.db.Query(`SELECT rev,item_id FROM item_tombstones WHERE user_id=? AND rev>? AND rev<=? ORDER BY rev LIMIT ?`, u.ID, since, upto, listPage+1)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	var gone []change
	for trows.Next() {
		var c change
		if trows.Scan(&c.rev, &c.id) == nil {
			gone = append(gone, c)
		}
	}
	trows.Close()
	if err := trows.Err(); err != nil {
		fail(w, 500, "server error")
		return
	}
	// both in number order; every number belongs to one change, so the page can end between any two
	items, removed := []map[string]any{}, []string{}
	last, sent, n := since, 0, 0
	more := false
	for i, j := 0, 0; i < len(changed) || j < len(gone); n++ {
		if n >= listPage || sent >= pageBytes {
			more = true
			break
		}
		var c change
		if j >= len(gone) || (i < len(changed) && changed[i].rev < gone[j].rev) {
			c, i = changed[i], i+1
		} else {
			c, j = gone[j], j+1
		}
		if c.item != nil {
			items = append(items, c.item)
			sent += len(c.item["wrapped_item_key"].(string)) + len(c.item["meta_enc"].(string))
		} else {
			removed = append(removed, c.id)
		}
		last = c.rev
	}
	if cut >= 0 && !more && last < st.rev {
		more = true // everything up to the cut went out; the rest comes with the next page
	}
	out["items"], out["removed"], out["more"] = items, removed, more
	if more {
		out["cursor"] = st.cursor(last)
	}
	writeJSON(w, 200, out)
}

// pruneTombstones drops tombstones older than tombRetention; a client whose cursor is older than one of them then
// loads its whole list (tomb_floor).
func (a *App) pruneTombstones() {
	cutoff := a.now().Add(-tombRetention).Unix()
	tx, err := a.db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE users SET tomb_floor=MAX(tomb_floor, (SELECT MAX(rev) FROM item_tombstones t WHERE t.user_id=users.id AND t.at<?))
		WHERE id IN (SELECT user_id FROM item_tombstones WHERE at<?)`, cutoff, cutoff); err != nil {
		return
	}
	res, err := tx.Exec(`DELETE FROM item_tombstones WHERE at<?`, cutoff)
	if err != nil {
		return
	}
	if tx.Commit() == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			log.Printf("pruned %d tombstones older than %d days", n, int(tombRetention.Hours()/24))
		}
	}
}
