package main

import "database/sql"

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

// migrateUsage adds users.used_bytes, (re)makes its triggers and sets every account's counter from the full sums, all
// in one transaction (taken with the write lock, so no change slips in between).
func migrateUsage(db *sql.DB) error {
	ucols, err := tableCols(db, "users")
	if err != nil {
		return err
	}
	if !ucols["used_bytes"] {
		if _, err := db.Exec(`ALTER TABLE users ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
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
	return tx.Commit()
}

// usedBytes is the account's counter: one row read, whatever the size of its library.
func (a *App) usedBytes(userID string) int64 {
	var used int64
	a.db.QueryRow(`SELECT used_bytes FROM users WHERE id=?`, userID).Scan(&used)
	return used
}
