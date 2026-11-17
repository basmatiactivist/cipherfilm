package main

import (
	"database/sql"
	"fmt"
)

// users.used_bytes is the storage an account takes (usedBytesSQL), kept up to date by the triggers below in the same
// statement, and so the same transaction, as every change of items.stored_bytes, item_index.data_enc and
// user_blobs.data_enc, whichever code path makes it (including deletions by a foreign key cascade). A quota check then
// reads one row instead of summing the whole library on every upload request, so one account's large library costs
// other accounts nothing.
//
// The triggers are made anew and the counters recomputed from the full sums at every start: a changed definition
// takes effect with the next version, a table rebuilt by a migration (which drops its triggers) gets them back, and a
// counter can never stay off.
var usageTriggers = []string{
	`DROP TRIGGER IF EXISTS usage_items_ins`,
	`DROP TRIGGER IF EXISTS usage_items_upd`,
	`DROP TRIGGER IF EXISTS usage_items_del`,
	`DROP TRIGGER IF EXISTS usage_index_ins`,
	`DROP TRIGGER IF EXISTS usage_index_upd`,
	`DROP TRIGGER IF EXISTS usage_index_del`,
	`DROP TRIGGER IF EXISTS usage_blobs_ins`,
	`DROP TRIGGER IF EXISTS usage_blobs_upd`,
	`DROP TRIGGER IF EXISTS usage_blobs_del`,
	`DROP TRIGGER IF EXISTS split_items_ins`,
	`DROP TRIGGER IF EXISTS split_items_upd`,
	`DROP TRIGGER IF EXISTS split_items_del`,
	`CREATE TRIGGER split_items_ins AFTER INSERT ON items BEGIN ` + splitChange("NEW", "+") + ` END`,
	`CREATE TRIGGER split_items_upd AFTER UPDATE OF stored_bytes,thumb_bytes,preview_bytes,kind,state,user_id ON items
BEGIN ` + splitChange("OLD", "-") + splitChange("NEW", "+") + ` END`,
	`CREATE TRIGGER split_items_del AFTER DELETE ON items BEGIN ` + splitChange("OLD", "-") + ` END`,
	`CREATE TRIGGER usage_items_ins AFTER INSERT ON items WHEN NEW.stored_bytes<>0
BEGIN UPDATE users SET used_bytes=used_bytes+NEW.stored_bytes WHERE id=NEW.user_id; END`,
	`CREATE TRIGGER usage_items_upd AFTER UPDATE OF stored_bytes,user_id ON items
WHEN OLD.stored_bytes IS NOT NEW.stored_bytes OR OLD.user_id IS NOT NEW.user_id
BEGIN
  UPDATE users SET used_bytes=used_bytes-OLD.stored_bytes WHERE id=OLD.user_id;
  UPDATE users SET used_bytes=used_bytes+NEW.stored_bytes WHERE id=NEW.user_id;
END`,
	`CREATE TRIGGER usage_items_del AFTER DELETE ON items WHEN OLD.stored_bytes<>0
BEGIN UPDATE users SET used_bytes=used_bytes-OLD.stored_bytes WHERE id=OLD.user_id; END`,
	`CREATE TRIGGER usage_index_ins AFTER INSERT ON item_index
BEGIN UPDATE users SET used_bytes=used_bytes+LENGTH(NEW.data_enc) WHERE id=NEW.user_id; END`,
	`CREATE TRIGGER usage_index_upd AFTER UPDATE OF data_enc,user_id ON item_index
BEGIN
  UPDATE users SET used_bytes=used_bytes-LENGTH(OLD.data_enc) WHERE id=OLD.user_id;
  UPDATE users SET used_bytes=used_bytes+LENGTH(NEW.data_enc) WHERE id=NEW.user_id;
END`,
	`CREATE TRIGGER usage_index_del AFTER DELETE ON item_index
BEGIN UPDATE users SET used_bytes=used_bytes-LENGTH(OLD.data_enc) WHERE id=OLD.user_id; END`,
	`CREATE TRIGGER usage_blobs_ins AFTER INSERT ON user_blobs
BEGIN UPDATE users SET used_bytes=used_bytes+LENGTH(NEW.data_enc) WHERE id=NEW.user_id; END`,
	`CREATE TRIGGER usage_blobs_upd AFTER UPDATE OF data_enc,user_id ON user_blobs
BEGIN
  UPDATE users SET used_bytes=used_bytes-LENGTH(OLD.data_enc) WHERE id=OLD.user_id;
  UPDATE users SET used_bytes=used_bytes+LENGTH(NEW.data_enc) WHERE id=NEW.user_id;
END`,
	`CREATE TRIGGER usage_blobs_del AFTER DELETE ON user_blobs
BEGIN UPDATE users SET used_bytes=used_bytes-LENGTH(OLD.data_enc) WHERE id=OLD.user_id; END`,
}

// The storage overview's split (storage.go) is kept the same way, in users.split_*: what an item's files take by its
// kind, its thumbnail and preview apart, and the number of finished items. The overview then reads one row too, so
// asking for it again and again costs the same for a large library as for a small one.
var splitCols = []string{"split_photos", "split_videos", "split_other", "split_aux", "ready_items"}

// itemAuxSQL is what an item's thumbnail and preview take of its stored_bytes, with the disk blocks they fill up
// (blockSlack). Items finished before thumb_bytes/preview_bytes existed have 0 there, so their small files count as
// the original: the split is close, the total exact.
func itemAuxSQL(r string) string {
	return fmt.Sprintf(`MIN(%[1]s.stored_bytes, %[1]s.thumb_bytes+(%[2]d-%[1]s.thumb_bytes%%%[2]d)%%%[2]d + %[1]s.preview_bytes+(%[2]d-%[1]s.preview_bytes%%%[2]d)%%%[2]d)`, r, diskBlock)
}

// splitTerms are one item's share of each splitCols counter, in that order; r is the row (NEW, OLD or a table alias).
func splitTerms(r string) []string {
	orig := `(` + r + `.stored_bytes-` + itemAuxSQL(r) + `)`
	return []string{
		`CASE WHEN ` + r + `.kind='image' THEN ` + orig + ` ELSE 0 END`,
		`CASE WHEN ` + r + `.kind='video' THEN ` + orig + ` ELSE 0 END`,
		`CASE WHEN ` + r + `.kind IN ('image','video') THEN 0 ELSE ` + orig + ` END`,
		itemAuxSQL(r),
		`(` + r + `.state='ready')`,
	}
}

// splitChange adds (sign "+") or takes away ("-") the item row r's share of the account's split counters.
func splitChange(r, sign string) string {
	q := `UPDATE users SET `
	for i, t := range splitTerms(r) {
		if i > 0 {
			q += `, `
		}
		q += splitCols[i] + `=` + splitCols[i] + sign + `(` + t + `)`
	}
	return q + ` WHERE id=` + r + `.user_id;`
}

// migrateUsage adds users.used_bytes and the split counters, (re)makes their triggers and sets every account's counters from the full sums, all
// in one transaction (taken with the write lock, so no change slips in between).
func migrateUsage(db *sql.DB) error {
	ucols, err := tableCols(db, "users")
	if err != nil {
		return err
	}
	for _, col := range append([]string{"used_bytes"}, splitCols...) {
		if !ucols[col] {
			if _, err := db.Exec(`ALTER TABLE users ADD COLUMN ` + col + ` INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range usageTriggers {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE users SET used_bytes=` + usedBytesSQL("users.id")); err != nil {
		return err
	}
	set := ``
	for i, t := range splitTerms("it") {
		if i > 0 {
			set += `, `
		}
		set += splitCols[i] + `=(SELECT COALESCE(SUM(` + t + `),0) FROM items it WHERE it.user_id=users.id)`
	}
	if _, err := tx.Exec(`UPDATE users SET ` + set); err != nil {
		return err
	}
	return tx.Commit()
}

// usedBytes is the account's counter: one row read, whatever the size of its library.
func (a *App) usedBytes(userID string) int64 {
	var used int64
	a.db.QueryRow(`SELECT used_bytes FROM users WHERE id=?`, userID).Scan(&used)
	return used
}
