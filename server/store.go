package main

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  kdf TEXT NOT NULL,
  auth_hash TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  wrapped_master_pw TEXT NOT NULL,
  wrapped_master_recovery TEXT NOT NULL,
  wrapped_privkey TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  pub TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
-- sessions signed out from another device: such a device is told so (X-CF-Session: revoked) and deletes its data
CREATE TABLE IF NOT EXISTS revoked_sessions (
  id_hash TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','other')),
  state TEXT NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','ready')),
  size_bytes INTEGER NOT NULL,
  segment_count INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  wrapped_item_key TEXT,
  meta_enc TEXT,
  has_thumb INTEGER NOT NULL DEFAULT 0,
  has_preview INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  trashed_at INTEGER
);
CREATE INDEX IF NOT EXISTS items_user ON items(user_id, state);
-- the library list's order, so a page doesn't sort the whole library first (and the trash's)
CREATE INDEX IF NOT EXISTS items_list ON items(user_id, state, created_at DESC, id);
CREATE INDEX IF NOT EXISTS items_trash ON items(user_id, trashed_at DESC, id);
CREATE TABLE IF NOT EXISTS segments (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (item_id, n)
);
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS albums_user ON albums(user_id);
CREATE TABLE IF NOT EXISTS album_items (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, item_id)
);
CREATE TABLE IF NOT EXISTS item_index (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL DEFAULT '',
  data_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, model)
);
CREATE INDEX IF NOT EXISTS item_index_user ON item_index(user_id, updated_at, item_id);
CREATE TABLE IF NOT EXISTS user_blobs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data_enc TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);
CREATE TABLE IF NOT EXISTS setup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT NOT NULL
);
`

func openDB(path string) (*sql.DB, error) {
	// _txlock=immediate: a transaction takes the write lock when it begins and waits for it (busy_timeout), instead
	// of failing with "database is locked" when it first reads and then writes while another write is going on
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=synchronous(FULL)&_txlock=immediate", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	// the incremental lists' change numbers, tombstones and triggers (since.go): after migrate, which they build on
	if err := migrateSync(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// migrate adds columns introduced after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS".
func migrate(db *sql.DB) error {
	have := map[string]bool{}
	rows, err := db.Query(`PRAGMA table_info(items)`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		if rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk) == nil {
			have[name] = true
		}
	}
	rows.Close()
	for _, col := range []string{"thumb_bytes", "preview_bytes", "favorite"} {
		if !have[col] {
			if _, err := db.Exec(`ALTER TABLE items ADD COLUMN ` + col + ` INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
		}
	}
	// users.last_login_at: when the person last signed in (the server sees this anyway)
	urows, err := db.Query(`PRAGMA table_info(users)`)
	if err != nil {
		return err
	}
	userCols := map[string]bool{}
	for urows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		if urows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk) == nil {
			userCols[name] = true
		}
	}
	urows.Close()
	// users.nsfw: the admin allows this person search of explicit content (an extra model in the apps); off by default
	for _, col := range []string{"last_login_at", "nsfw"} {
		if !userCols[col] {
			if _, err := db.Exec(`ALTER TABLE users ADD COLUMN ` + col + ` INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
		}
	}
	// invites.quota_bytes: storage limit chosen when inviting (NULL = the server default)
	irows, err := db.Query(`PRAGMA table_info(invites)`)
	if err != nil {
		return err
	}
	hasInvQuota := false
	for irows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		if irows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk) == nil && name == "quota_bytes" {
			hasInvQuota = true
		}
	}
	irows.Close()
	if !hasInvQuota {
		if _, err := db.Exec(`ALTER TABLE invites ADD COLUMN quota_bytes INTEGER`); err != nil {
			return err
		}
	}
	// users.indexer: the one device (session pub id) that computes the search index; the others only read it
	if !userCols["indexer"] {
		if _, err := db.Exec(`ALTER TABLE users ADD COLUMN indexer TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}
	// sessions.pub: an id for the device list that is not the cookie's hash; sessions.device: what the device calls itself
	scols, err := tableCols(db, "sessions")
	if err != nil {
		return err
	}
	for _, col := range []string{"pub", "device"} {
		if !scols[col] {
			if _, err := db.Exec(`ALTER TABLE sessions ADD COLUMN ` + col + ` TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
		}
	}
	if _, err := db.Exec(`UPDATE sessions SET pub=lower(hex(randomblob(12))) WHERE pub=''`); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS sessions_pub ON sessions(pub)`); err != nil {
		return err
	}
	// item_index.model: one entry per item and model family, so entries of the standard and the explicit model don't
	// overwrite each other (before 1.9.0 an item had one entry; those keep the family '' and are read as either)
	icols, err := tableCols(db, "item_index")
	if err != nil {
		return err
	}
	if !icols["model"] {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		for _, q := range []string{
			`CREATE TABLE item_index_m (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL DEFAULT '',
  data_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, model)
)`,
			`INSERT INTO item_index_m(item_id,user_id,model,data_enc,updated_at) SELECT item_id,user_id,'',data_enc,updated_at FROM item_index`,
			`DROP TABLE item_index`,
			`ALTER TABLE item_index_m RENAME TO item_index`,
			`CREATE INDEX IF NOT EXISTS item_index_user ON item_index(user_id, updated_at, item_id)`,
		} {
			if _, err := tx.Exec(q); err != nil {
				return err
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func tableCols(db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		if rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk) == nil {
			have[name] = true
		}
	}
	return have, rows.Err()
}
