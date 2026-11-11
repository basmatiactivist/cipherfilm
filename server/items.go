package main

import (
	"database/sql"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Segment format constants; must match web/src/crypto/file.ts.
const (
	segPlain         = 4 << 20
	chunkPlain       = 64 << 10
	cipherHeader     = 24
	cipherChunkExtra = 17
	maxFileBytes     = 8 << 30
	maxThumbBytes    = 256 << 10
	maxPreviewBytes  = 3 << 20
	maxMetaBytes     = 16 << 10
	defaultUserQuota = 20 << 30
	staleUpload      = 48 * time.Hour
	maxOpenUploads   = 50
	orphanGrace      = 10 * time.Minute
	trashRetention   = 30 * 24 * time.Hour
	itemOverhead     = 4 << 10 // what a finished item costs beyond its files (database row, directory), on the quota
	diskBlock        = 4 << 10 // files take whole blocks on disk: the unused rest of each file's last block is charged
)

// blockSlack is what a file of n bytes takes on disk beyond n.
func blockSlack(n int64) int64 {
	return (diskBlock - n%diskBlock) % diskBlock
}

var idRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

func segCount(total int64) int64 {
	if total <= 0 {
		return 1
	}
	return (total + segPlain - 1) / segPlain
}

func cipherLen(p int64) int64 {
	chunks := (p + chunkPlain - 1) / chunkPlain
	if chunks < 1 {
		chunks = 1
	}
	return cipherHeader + p + chunks*cipherChunkExtra
}

// expectedSegmentLen is the exact ciphertext size the server accepts for segment n.
func expectedSegmentLen(total, n int64) int64 {
	p := int64(segPlain)
	if n == segCount(total)-1 {
		p = total - n*segPlain
	}
	return cipherLen(p)
}

func (a *App) itemRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/items", a.auth(false, a.createItem))
	m.HandleFunc("GET /api/items", a.auth(false, a.listing(a.listItems)))
	m.HandleFunc("GET /api/items/{id}/upload", a.auth(false, a.uploadState))
	m.HandleFunc("PUT /api/items/{id}/segments/{n}", a.auth(false, a.putSegment))
	m.HandleFunc("PUT /api/items/{id}/thumb", a.auth(false, a.putAux("thumb", maxThumbBytes, "has_thumb")))
	m.HandleFunc("PUT /api/items/{id}/preview", a.auth(false, a.putAux("preview", maxPreviewBytes, "has_preview")))
	m.HandleFunc("PUT /api/items/{id}/replace/thumb", a.auth(false, a.replaceAux("thumb", maxThumbBytes, "has_thumb")))
	m.HandleFunc("PUT /api/items/{id}/replace/preview", a.auth(false, a.replaceAux("preview", maxPreviewBytes, "has_preview")))
	m.HandleFunc("POST /api/items/{id}/finalize", a.auth(false, a.finalizeItem))
	m.HandleFunc("PUT /api/items/{id}/meta", a.auth(false, a.putMeta))
	m.HandleFunc("GET /api/items/{id}/segments/{n}", a.auth(false, a.getBlob("seg")))
	m.HandleFunc("GET /api/items/{id}/thumb", a.auth(false, a.getBlob("thumb")))
	m.HandleFunc("GET /api/items/{id}/preview", a.auth(false, a.getBlob("preview")))
	m.HandleFunc("DELETE /api/items/{id}", a.auth(false, a.abortItem))
	m.HandleFunc("POST /api/items/trash", a.auth(false, a.trashItems(true)))
	m.HandleFunc("POST /api/items/restore", a.auth(false, a.trashItems(false)))
	m.HandleFunc("GET /api/trash", a.auth(false, a.listing(a.listTrash)))
	m.HandleFunc("POST /api/trash/purge", a.auth(false, a.purgeTrash))
}

// ---- blob files ----

func (a *App) itemDir(id string) string {
	if !idRe.MatchString(id) {
		panic("invalid item id") // callers validate; never build a path from unchecked input
	}
	return filepath.Join(a.dataDir, "blobs", id[:2], id)
}

func (a *App) removeBlobs(id string) {
	if idRe.MatchString(id) {
		os.RemoveAll(a.itemDir(id))
	}
}

// errBadSize: the body arrived complete but valid() rejected its length. Nothing was written.
var errBadSize = errors.New("wrong size")

// writeAtomic stores r as dir/name only if it arrives complete and valid accepts its length. It writes a temporary
// file and renames it into place, so a broken or rejected upload never replaces or removes what is already there.
func writeAtomic(dir, name string, r io.Reader, valid func(int64) bool) (int64, error) {
	tmp, n, err := writeStaged(dir, r, valid)
	if err != nil {
		return n, err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		os.Remove(tmp)
		return 0, err
	}
	return n, nil
}

// writeStaged is writeAtomic without the rename: the caller gets the complete, valid temporary file and moves it into
// place itself (or removes it).
func writeStaged(dir string, r io.Reader, valid func(int64) bool) (string, int64, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", 0, err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return "", 0, err
	}
	n, err := io.Copy(tmp, r)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil && !valid(n) {
		err = errBadSize
	}
	if err != nil {
		os.Remove(tmp.Name())
		return "", n, err
	}
	return tmp.Name(), n, nil
}

func (a *App) itemIDs(userID string) []string {
	rows, err := a.db.Query(`SELECT id FROM items WHERE user_id=?`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out
}

// ---- handlers ----

type ownedItem struct {
	ID, State   string
	Size, Count int64
	Stored      int64
}

// owned loads an item only if it belongs to the signed-in user; everything else is a plain 404.
func (a *App) owned(w http.ResponseWriter, r *http.Request, u *user) (*ownedItem, bool) {
	id := r.PathValue("id")
	if !idRe.MatchString(id) {
		fail(w, 404, "not found")
		return nil, false
	}
	it := ownedItem{ID: id}
	err := a.db.QueryRow(`SELECT state,size_bytes,segment_count,stored_bytes FROM items WHERE id=? AND user_id=?`, id, u.ID).
		Scan(&it.State, &it.Size, &it.Count, &it.Stored)
	if err != nil {
		fail(w, 404, "not found")
		return nil, false
	}
	return &it, true
}

// usedBytesSQL is the storage an account takes: its files plus its encrypted index entries and documents, which live
// in app.db. id is the SQL expression for the account's id.
func usedBytesSQL(id string) string {
	return `(COALESCE((SELECT SUM(stored_bytes) FROM items WHERE user_id=` + id + `),0)
		+ COALESCE((SELECT SUM(LENGTH(data_enc)) FROM item_index WHERE user_id=` + id + `),0)
		+ COALESCE((SELECT SUM(LENGTH(data_enc)) FROM user_blobs WHERE user_id=` + id + `),0))`
}

func (a *App) quotaLeft(userID string) (left int64, unlimited bool) {
	var quota, used sql.NullInt64
	a.db.QueryRow(`SELECT quota_bytes FROM users WHERE id=?`, userID).Scan(&quota)
	a.db.QueryRow(`SELECT `+usedBytesSQL("?"), userID, userID, userID).Scan(&used)
	if quota.Int64 == 0 {
		return 0, true
	}
	return quota.Int64 - used.Int64, false
}

// reserveBytes holds `want` bytes of the user's quota while an upload body is being written, so concurrent
// uploads cannot all pass the quota check before any of them is counted. Call release when the upload is done
// (after stored_bytes has been updated, or on failure).
func (a *App) reserveBytes(userID string, want int64) (release func(), ok bool) {
	a.resMu.Lock()
	defer a.resMu.Unlock()
	if want <= 0 {
		return func() {}, true
	}
	left, unlimited := a.quotaLeft(userID)
	if !unlimited && left-a.reserved[userID] < want {
		return nil, false
	}
	a.reserved[userID] += want
	return func() {
		a.resMu.Lock()
		a.reserved[userID] -= want
		a.resMu.Unlock()
	}, true
}

// cleanupIfGone removes blobs of an item whose row no longer exists (a write that raced with a delete).
func (a *App) cleanupIfGone(id string) {
	if a.itemGone(id) {
		a.removeBlobs(id)
	}
}

// itemGone is true only when the database positively says the item has no row. A failed query (database busy,
// I/O error) counts as "still there": deleting files of a live item can't be undone, leaving an orphan for the
// next sweep costs nothing.
func (a *App) itemGone(id string) bool {
	var n int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM items WHERE id=?`, id).Scan(&n); err != nil {
		return false
	}
	return n == 0
}

type createReq struct {
	Kind         string `json:"kind"`
	Size         int64  `json:"size"`
	SegmentCount int64  `json:"segment_count"`
}

func (a *App) createItem(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req createReq
	if !readJSON(w, r, &req) {
		return
	}
	if (req.Kind != "image" && req.Kind != "video" && req.Kind != "other") || req.Size < 0 || req.Size > maxFileBytes || req.SegmentCount != segCount(req.Size) {
		fail(w, 400, "invalid request")
		return
	}
	if left, unlimited := a.quotaLeft(u.ID); !unlimited && left < cipherLen(req.Size) {
		fail(w, 413, "this would go over your storage limit")
		return
	}
	var open int
	a.db.QueryRow(`SELECT COUNT(*) FROM items WHERE user_id=? AND state='uploading'`, u.ID).Scan(&open)
	if open >= maxOpenUploads {
		fail(w, 429, "too many unfinished uploads; finish or cancel some first")
		return
	}
	id := randID()
	if _, err := a.db.Exec(`INSERT INTO items(id,user_id,kind,size_bytes,segment_count,created_at) VALUES (?,?,?,?,?,?)`,
		id, u.ID, req.Kind, req.Size, req.SegmentCount, a.now().Unix()); err != nil {
		fail(w, 500, "server error")
		return
	}
	writeJSON(w, 201, map[string]any{"id": id})
}

func (a *App) uploadState(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	it, ok := a.owned(w, r, u)
	if !ok {
		return
	}
	received := []int64{}
	if rows, err := a.db.Query(`SELECT n FROM segments WHERE item_id=? ORDER BY n`, it.ID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var n int64
			if rows.Scan(&n) == nil {
				received = append(received, n)
			}
		}
	}
	var hasThumb, hasPreview bool
	a.db.QueryRow(`SELECT has_thumb,has_preview FROM items WHERE id=?`, it.ID).Scan(&hasThumb, &hasPreview)
	writeJSON(w, 200, map[string]any{"state": it.State, "size": it.Size, "segment_count": it.Count, "received": received, "has_thumb": hasThumb, "has_preview": hasPreview})
}

func (a *App) putSegment(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	it, ok := a.owned(w, r, u)
	if !ok {
		return
	}
	n, err := strconv.ParseInt(r.PathValue("n"), 10, 64)
	if err != nil || n < 0 || n >= it.Count || it.State != "uploading" {
		fail(w, 400, "invalid request")
		return
	}
	want := expectedSegmentLen(it.Size, n)
	var prev int64
	a.db.QueryRow(`SELECT bytes FROM segments WHERE item_id=? AND n=?`, it.ID, n).Scan(&prev)
	// the body is staged in full next to the stored copy until it replaces it, so the whole part is reserved for
	// that time, not only what it adds: otherwise re-sends of a stored part would put files on disk beyond the quota
	release, ok := a.reserveBytes(u.ID, want)
	if !ok {
		if prev == want {
			// already stored in full (a retry after a lost answer): keep that copy, no room needed
			writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		fail(w, 413, "this would go over your storage limit")
		return
	}
	defer release()
	bodyDeadline(w, uploadReadTime)
	r.Body = http.MaxBytesReader(w, r.Body, want+1)
	got, err := writeAtomic(a.itemDir(it.ID), fmt.Sprintf("seg%06d", n), r.Body, func(n int64) bool { return n == want })
	if err != nil {
		// nothing was written: a copy of this segment stored by an earlier attempt stays as it is, and so does its row
		a.cleanupIfGone(it.ID)
		if errors.Is(err, errBadSize) {
			fail(w, 400, "a part has the wrong size")
		} else {
			fail(w, 400, "couldn't save the upload")
		}
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		a.cleanupIfGone(it.ID)
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback()
	// on failure the transaction is rolled back before cleanupIfGone asks the pool for another connection: while it
	// is open it holds one connection and SQLite's write lock, and enough such waits at once would stall every request
	// the charge is the difference to what is recorded now: two uploads of the same part at once count it once
	prev = 0
	tx.QueryRow(`SELECT bytes FROM segments WHERE item_id=? AND n=?`, it.ID, n).Scan(&prev)
	if _, err := tx.Exec(`INSERT INTO segments(item_id,n,bytes) VALUES (?,?,?) ON CONFLICT(item_id,n) DO UPDATE SET bytes=excluded.bytes`, it.ID, n, got); err != nil {
		tx.Rollback()
		a.cleanupIfGone(it.ID) // the item was deleted while the body was streaming: do not leave the file behind
		fail(w, 500, "server error")
		return
	}
	res, err := tx.Exec(`UPDATE items SET stored_bytes = stored_bytes + ? WHERE id=? AND state='uploading'`, got-prev, it.ID)
	if rowsAffected(res, err) != 1 {
		tx.Rollback()
		a.cleanupIfGone(it.ID)
		fail(w, 409, "this upload is no longer open")
		return
	}
	if err := tx.Commit(); err != nil {
		a.cleanupIfGone(it.ID)
		fail(w, 500, "server error")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) putAux(name string, max int64, col string) func(http.ResponseWriter, *http.Request, *user, *session) {
	bytesCol := strings.TrimPrefix(col, "has_") + "_bytes"
	return func(w http.ResponseWriter, r *http.Request, u *user, s *session) {
		it, ok := a.owned(w, r, u)
		if !ok {
			return
		}
		if it.State != "uploading" {
			fail(w, 409, "this upload is already finished")
			return
		}
		// thumbnails and previews count toward the quota like everything else; reserve the full maximum (a
		// replacement is settled atomically below, so concurrent PUTs cannot drive the counter off)
		release, ok := a.reserveBytes(u.ID, max)
		if !ok {
			fail(w, 413, "this would go over your storage limit")
			return
		}
		defer release()
		bodyDeadline(w, uploadReadTime)
		r.Body = http.MaxBytesReader(w, r.Body, max+1)
		tmp, got, err := writeStaged(a.itemDir(it.ID), r.Body, func(n int64) bool { return n >= 1+24+16 && n <= max })
		if err != nil { // nothing was written; an earlier thumbnail or preview stays
			a.cleanupIfGone(it.ID)
			fail(w, 400, "invalid upload")
			return
		}
		defer os.Remove(tmp) // a no-op once it has been renamed
		// counted first, moved into place only if the count went through: once the upload is finalized (or gone), the
		// body must not land on disk without being charged. auxMu keeps each count paired with its own file.
		a.auxMu.Lock()
		defer a.auxMu.Unlock()
		res, err := a.db.Exec(`UPDATE items SET `+col+`=1, stored_bytes=MAX(0, stored_bytes-`+bytesCol+`+?), `+bytesCol+`=? WHERE id=? AND state='uploading'`, got, got, it.ID)
		if rowsAffected(res, err) != 1 {
			a.cleanupIfGone(it.ID)
			fail(w, 409, "this upload is no longer open")
			return
		}
		if err := os.Rename(tmp, filepath.Join(a.itemDir(it.ID), name)); err != nil {
			fail(w, 500, "server error")
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

// replaceAux replaces the thumbnail or preview of a finished item: an app made new ones after the person turned or
// cropped the photo (docs/EDITING.md). The encrypted original is never touched. Only the owner's own items that are
// not in the trash; the same size checks as at upload, and the difference counts toward the storage limit (with the
// disk blocks the file takes, as finalize charged them). The other devices see the change in the change list.
func (a *App) replaceAux(name string, max int64, col string) func(http.ResponseWriter, *http.Request, *user, *session) {
	bytesCol := strings.TrimPrefix(col, "has_") + "_bytes"
	return func(w http.ResponseWriter, r *http.Request, u *user, s *session) {
		it, ok := a.owned(w, r, u)
		if !ok {
			return
		}
		if it.State != "ready" {
			fail(w, 409, "this upload isn't finished")
			return
		}
		release, ok := a.reserveBytes(u.ID, max+diskBlock)
		if !ok {
			fail(w, 413, "this would go over your storage limit")
			return
		}
		defer release()
		bodyDeadline(w, uploadReadTime)
		r.Body = http.MaxBytesReader(w, r.Body, max+1)
		tmp, got, err := writeStaged(a.itemDir(it.ID), r.Body, func(n int64) bool { return n >= 1+24+16 && n <= max })
		if err != nil { // nothing was written; the earlier one stays
			a.cleanupIfGone(it.ID)
			fail(w, 400, "invalid upload")
			return
		}
		defer os.Remove(tmp) // a no-op once it has been renamed
		a.auxMu.Lock()
		defer a.auxMu.Unlock()
		var old int64
		if err := a.db.QueryRow(`SELECT `+bytesCol+` FROM items WHERE id=? AND user_id=?`, it.ID, u.ID).Scan(&old); err != nil {
			a.cleanupIfGone(it.ID)
			fail(w, 404, "not found")
			return
		}
		grow := got + blockSlack(got) - old - blockSlack(old)
		res, err := a.db.Exec(`UPDATE items SET `+col+`=1, stored_bytes=MAX(0, stored_bytes+?), `+bytesCol+`=? WHERE id=? AND user_id=? AND state='ready' AND trashed_at IS NULL AND `+bytesCol+`=?`,
			grow, got, it.ID, u.ID, old)
		if rowsAffected(res, err) != 1 {
			a.cleanupIfGone(it.ID)
			fail(w, 409, "the item changed meanwhile")
			return
		}
		if err := os.Rename(tmp, filepath.Join(a.itemDir(it.ID), name)); err != nil {
			fail(w, 500, "server error")
			return
		}
		a.changed(u.ID, tItems)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

// segmentsOnDisk checks every segment file of an upload before it is marked ready: a row says a part arrived, the file
// must agree. A part whose file is missing or has the wrong length loses its row (and its bytes), so the client's
// resume uploads it again instead of the app reporting a damaged file as done.
func (a *App) segmentsOnDisk(it *ownedItem) bool {
	complete := true
	for n := int64(0); n < it.Count; n++ {
		fi, err := os.Stat(filepath.Join(a.itemDir(it.ID), fmt.Sprintf("seg%06d", n)))
		if err == nil && fi.Mode().IsRegular() && fi.Size() == expectedSegmentLen(it.Size, n) {
			continue
		}
		complete = false
		var bytes int64
		if a.db.QueryRow(`SELECT bytes FROM segments WHERE item_id=? AND n=?`, it.ID, n).Scan(&bytes) == nil {
			if tx, err := a.db.Begin(); err == nil {
				tx.Exec(`DELETE FROM segments WHERE item_id=? AND n=?`, it.ID, n)
				tx.Exec(`UPDATE items SET stored_bytes = MAX(0, stored_bytes - ?) WHERE id=?`, bytes, it.ID)
				tx.Commit()
			}
		}
	}
	return complete
}

type finalizeReq struct {
	WrappedItemKey string `json:"wrapped_item_key"`
	MetaEnc        string `json:"meta_enc"`
}

func (a *App) finalizeItem(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	it, ok := a.owned(w, r, u)
	if !ok {
		return
	}
	var req finalizeReq
	if !readJSON(w, r, &req) {
		return
	}
	meta, err := b64.DecodeString(req.MetaEnc)
	badKey := checkLen(req.WrappedItemKey, wrappedLen) != nil && checkLen(req.WrappedItemKey, sealedItemKeyLen) != nil
	if badKey || err != nil || len(meta) < 1+24+16 || len(meta) > maxMetaBytes {
		fail(w, 400, "invalid request")
		return
	}
	var have int64
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM segments WHERE item_id=?`, it.ID).Scan(&have); err != nil {
		fail(w, 500, "server error")
		return
	}
	if have != it.Count || !a.segmentsOnDisk(it) {
		fail(w, 409, "some parts are still missing")
		return
	}
	// the encrypted metadata, the item's own overhead and the blocks its files take count toward the quota too, so
	// many tiny items cost what they take on disk
	extra := int64(len(req.MetaEnc)+len(req.WrappedItemKey)) + itemOverhead
	var thumb, preview int64
	a.db.QueryRow(`SELECT thumb_bytes,preview_bytes FROM items WHERE id=?`, it.ID).Scan(&thumb, &preview)
	extra += blockSlack(thumb) + blockSlack(preview)
	if rows, err := a.db.Query(`SELECT bytes FROM segments WHERE item_id=?`, it.ID); err == nil {
		for rows.Next() {
			var n int64
			if rows.Scan(&n) == nil {
				extra += blockSlack(n)
			}
		}
		rows.Close()
	}
	release, ok := a.reserveBytes(u.ID, extra)
	if !ok {
		fail(w, 413, "this would go over your storage limit")
		return
	}
	defer release()
	res, err := a.db.Exec(`UPDATE items SET state='ready', wrapped_item_key=?, meta_enc=?, stored_bytes=stored_bytes+? WHERE id=? AND user_id=? AND state='uploading'`, req.WrappedItemKey, req.MetaEnc, extra, it.ID, u.ID)
	if rowsAffected(res, err) != 1 {
		fail(w, 409, "this upload is already finished")
		return
	}
	a.changed(u.ID, tItems)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// putMeta replaces a finished item's encrypted metadata: an app adds what it could only read later, such as where a
// photo was taken (docs/MAP.md). The server can't read it, as at finalize; the change reaches the other devices like
// any other (items_rev_upd). Its size counts toward the storage limit like the rest of the item.
func (a *App) putMeta(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	it, ok := a.owned(w, r, u)
	if !ok {
		return
	}
	var req struct {
		MetaEnc string `json:"meta_enc"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	meta, err := b64.DecodeString(req.MetaEnc)
	if err != nil || len(meta) < 1+24+16 || len(meta) > maxMetaBytes {
		fail(w, 400, "invalid request")
		return
	}
	if it.State != "ready" {
		fail(w, 409, "this upload isn't finished")
		return
	}
	var old string
	if err := a.db.QueryRow(`SELECT COALESCE(meta_enc,'') FROM items WHERE id=? AND user_id=?`, it.ID, u.ID).Scan(&old); err != nil {
		fail(w, 404, "not found")
		return
	}
	grow := int64(len(req.MetaEnc) - len(old))
	release, ok := a.reserveBytes(u.ID, grow)
	if !ok {
		fail(w, 413, "this would go over your storage limit")
		return
	}
	defer release()
	res, err := a.db.Exec(`UPDATE items SET meta_enc=?, stored_bytes=stored_bytes+? WHERE id=? AND user_id=? AND state='ready' AND COALESCE(meta_enc,'')=?`,
		req.MetaEnc, grow, it.ID, u.ID, old)
	if rowsAffected(res, err) != 1 {
		fail(w, 409, "the item changed meanwhile")
		return
	}
	a.changed(u.ID, tItems)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// listPage and pageBytes bound one list response, in rows and in the bytes of their encrypted fields: a library is
// fetched page by page (?after=<next of the previous page>), so its size never decides how much memory one request
// takes. listPerUser bounds how many pages of one account are built and sent at a time; more wait their turn.
var (
	// vars for the tests of paging
	listPage  = 2000
	pageBytes = 4 << 20
)

const (
	listPerUser   = 4
	listWriteTime = 5 * time.Minute
)

// listing runs a list handler in its turn (see listPerUser). A client that stops reading is cut off after
// listWriteTime, so it cannot hold its turn and its page for ever.
func (a *App) listing(h func(http.ResponseWriter, *http.Request, *user, *session)) func(http.ResponseWriter, *http.Request, *user, *session) {
	return func(w http.ResponseWriter, r *http.Request, u *user, s *session) {
		key := u.ID
		if a.isDemo(u) {
			// every visitor shares the demo login: turns per source (one of 64 groups, so the map stays small),
			// so one visitor holding the account's turns doesn't stop everyone else
			h := fnv.New32a()
			h.Write([]byte(limiterIP(a.clientIP(r))))
			key = fmt.Sprintf("demo|%d", h.Sum32()%64)
		}
		a.listMu.Lock()
		turn := a.lists[key]
		if turn == nil {
			turn = make(chan struct{}, listPerUser)
			a.lists[key] = turn
		}
		a.listMu.Unlock()
		select {
		case turn <- struct{}{}:
			defer func() { <-turn }()
		case <-r.Context().Done():
			return
		}
		http.NewResponseController(w).SetWriteDeadline(time.Now().Add(listWriteTime))
		h(w, r, u, s)
	}
}

// pageAfter reads the ?after cursor: "<timestamp>.<id>" of the last item on the previous page.
func pageAfter(r *http.Request) (ts int64, id string, has, ok bool) {
	v := r.URL.Query().Get("after")
	if v == "" {
		return 0, "", false, true
	}
	t, i, found := strings.Cut(v, ".")
	n, err := strconv.ParseInt(t, 10, 64)
	if !found || err != nil || !idRe.MatchString(i) {
		return 0, "", false, false
	}
	return n, i, true, true
}

func (a *App) listItems(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	if r.URL.Query().Has("since") {
		left, unlimited := a.quotaLeft(u.ID)
		a.listSince(w, r, u, false, map[string]any{"quota_left": left, "unlimited": unlimited})
		return
	}
	ts, after, has, ok := pageAfter(r)
	if !ok {
		fail(w, 400, "invalid request")
		return
	}
	// read before the rows: whatever changes while the pages load comes with the client's first ?since
	st, err := a.syncState(u.ID)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	q, args := `SELECT id,kind,size_bytes,segment_count,wrapped_item_key,meta_enc,has_thumb,has_preview,created_at,favorite FROM items WHERE user_id=? AND state='ready' AND trashed_at IS NULL`, []any{u.ID}
	if has {
		q, args = q+` AND (created_at < ? OR (created_at = ? AND id > ?))`, append(args, ts, ts, after)
	}
	rows, err := a.db.QueryContext(r.Context(), q+` ORDER BY created_at DESC, id LIMIT ?`, append(args, listPage)...)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	next := ""
	sent := 0 // bytes of encrypted fields on this page
	for sent < pageBytes && rows.Next() {
		var id, kind, key, meta string
		var size, count, created int64
		var th, pv, fav bool
		if rows.Scan(&id, &kind, &size, &count, &key, &meta, &th, &pv, &created, &fav) == nil {
			out = append(out, map[string]any{"id": id, "kind": kind, "size": size, "segment_count": count, "wrapped_item_key": key, "meta_enc": meta, "has_thumb": th, "has_preview": pv, "created_at": created, "favorite": fav})
			next = fmt.Sprintf("%d.%s", created, id)
			sent += len(key) + len(meta)
		}
	}
	if !donePage(w, rows) {
		return
	}
	if len(out) < listPage && sent < pageBytes {
		next = ""
	}
	var left int64
	var unlimited bool
	left, unlimited = a.quotaLeft(u.ID)
	writeJSON(w, 200, map[string]any{"items": out, "next": next, "quota_left": left, "unlimited": unlimited, "cursor": st.cursor(st.rev)})
}

// donePage ends the reading of a list page. A page cut at pageBytes leaves rows unread, and open rows keep one of
// the few pooled database connections: it goes back before any further query and before the (possibly slow) write.
func donePage(w http.ResponseWriter, rows *sql.Rows) bool {
	rows.Close()
	if rows.Err() != nil {
		fail(w, 500, "server error")
		return false
	}
	return true
}

func (a *App) getBlob(kind string) func(http.ResponseWriter, *http.Request, *user, *session) {
	return func(w http.ResponseWriter, r *http.Request, u *user, s *session) {
		it, ok := a.owned(w, r, u)
		if !ok {
			return
		}
		name := kind
		if kind == "seg" {
			n, err := strconv.ParseInt(r.PathValue("n"), 10, 64)
			if err != nil || n < 0 || n >= it.Count {
				fail(w, 404, "not found")
				return
			}
			name = fmt.Sprintf("seg%06d", n)
		}
		f, err := os.Open(filepath.Join(a.itemDir(it.ID), name))
		if err != nil {
			fail(w, 404, "not found")
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeContent(w, r, "", time.Time{}, f)
	}
}

// abortItem discards an unfinished upload. (Finished items are removed through the trash, from M6.)
func (a *App) abortItem(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	it, ok := a.owned(w, r, u)
	if !ok {
		return
	}
	if it.State != "uploading" {
		fail(w, 409, "only unfinished uploads can be discarded")
		return
	}
	// only while still unfinished: an upload finalized meanwhile goes through the trash like any other item
	res, err := a.db.Exec(`DELETE FROM items WHERE id=? AND user_id=? AND state='uploading'`, it.ID, u.ID)
	if rowsAffected(res, err) != 1 {
		fail(w, 409, "only unfinished uploads can be discarded")
		return
	}
	a.removeBlobs(it.ID)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// janitor removes abandoned uploads.
func (a *App) janitor() {
	a.sweepTemps(a.now())
	for {
		a.sweepStale()
		a.purgeExpiredTrash()
		a.pruneTombstones()
		a.sweepOrphans()
		time.Sleep(time.Hour)
	}
}

func (a *App) sweepStale() {
	cutoff := a.now().Add(-staleUpload).Unix()
	rows, err := a.db.Query(`SELECT id FROM items WHERE state='uploading' AND created_at < ?`, cutoff)
	if err != nil {
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
	for _, id := range ids {
		// the condition again, in the delete itself: the upload may have been finalized since the select
		res, err := a.db.Exec(`DELETE FROM items WHERE id=? AND state='uploading' AND created_at < ?`, id, cutoff)
		if rowsAffected(res, err) == 1 {
			a.removeBlobs(id)
		}
	}
	if len(ids) > 0 {
		log.Printf("removed %d abandoned uploads", len(ids))
	}
}

var _ = errors.New

// ---- trash ----

type idsReq struct {
	ItemIDs []string `json:"item_ids"`
}

func validIDs(ids []string) bool {
	if len(ids) == 0 || len(ids) > maxAlbumBatch {
		return false
	}
	for _, id := range ids {
		if !idRe.MatchString(id) {
			return false
		}
	}
	return true
}

// trashItems moves the caller's items into the trash (or restores them). Trashed items keep counting toward the quota.
func (a *App) trashItems(toTrash bool) func(http.ResponseWriter, *http.Request, *user, *session) {
	return func(w http.ResponseWriter, r *http.Request, u *user, s *session) {
		var req idsReq
		if !readJSON(w, r, &req) || !validIDs(req.ItemIDs) {
			fail(w, 400, "invalid request")
			return
		}
		tx, err := a.db.BeginTx(r.Context(), nil)
		if err != nil {
			fail(w, 500, "server error")
			return
		}
		defer tx.Rollback()
		for _, id := range req.ItemIDs {
			var res sql.Result
			if toTrash {
				res, err = tx.Exec(`UPDATE items SET trashed_at=? WHERE id=? AND user_id=? AND state='ready' AND trashed_at IS NULL`, a.now().Unix(), id, u.ID)
			} else {
				res, err = tx.Exec(`UPDATE items SET trashed_at=NULL WHERE id=? AND user_id=? AND state='ready' AND trashed_at IS NOT NULL`, id, u.ID)
			}
			if rowsAffected(res, err) != 1 {
				fail(w, 404, "not found")
				return
			}
		}
		if err := tx.Commit(); err != nil {
			fail(w, 500, "server error")
			return
		}
		// albums list only what is not in the trash
		a.changed(u.ID, tItems|tTrash|tAlbums)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

func (a *App) listTrash(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	days := int(trashRetention.Hours() / 24)
	if r.URL.Query().Has("since") {
		a.listSince(w, r, u, true, map[string]any{"retention_days": days})
		return
	}
	ts, after, has, ok := pageAfter(r)
	if !ok {
		fail(w, 400, "invalid request")
		return
	}
	st, err := a.syncState(u.ID)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	q, args := `SELECT id,kind,size_bytes,segment_count,wrapped_item_key,meta_enc,has_thumb,has_preview,created_at,trashed_at FROM items WHERE user_id=? AND state='ready' AND trashed_at IS NOT NULL`, []any{u.ID}
	if has {
		q, args = q+` AND (trashed_at < ? OR (trashed_at = ? AND id > ?))`, append(args, ts, ts, after)
	}
	rows, err := a.db.QueryContext(r.Context(), q+` ORDER BY trashed_at DESC, id LIMIT ?`, append(args, listPage)...)
	if err != nil {
		fail(w, 500, "server error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	next := ""
	sent := 0 // bytes of encrypted fields on this page
	for sent < pageBytes && rows.Next() {
		var id, kind, key, meta string
		var size, count, created, trashed int64
		var th, pv bool
		if rows.Scan(&id, &kind, &size, &count, &key, &meta, &th, &pv, &created, &trashed) == nil {
			out = append(out, map[string]any{"id": id, "kind": kind, "size": size, "segment_count": count, "wrapped_item_key": key, "meta_enc": meta, "has_thumb": th, "has_preview": pv, "created_at": created, "trashed_at": trashed, "purge_at": trashed + int64(trashRetention.Seconds())})
			next = fmt.Sprintf("%d.%s", trashed, id)
			sent += len(key) + len(meta)
		}
	}
	if !donePage(w, rows) {
		return
	}
	if len(out) < listPage && sent < pageBytes {
		next = ""
	}
	writeJSON(w, 200, map[string]any{"items": out, "next": next, "retention_days": days, "cursor": st.cursor(st.rev)})
}

// purgeTrash permanently deletes the given trashed items, blobs included. There is no "everything" form: the client
// names what it showed, so an empty or stale selection can never turn into emptying the whole trash.
func (a *App) purgeTrash(w http.ResponseWriter, r *http.Request, u *user, s *session) {
	var req idsReq
	if !readJSON(w, r, &req) {
		return
	}
	if !validIDs(req.ItemIDs) { // also rejects an empty list
		fail(w, 400, "invalid request")
		return
	}
	ids := req.ItemIDs
	removed := 0
	for _, id := range ids {
		res, err := a.db.Exec(`DELETE FROM items WHERE id=? AND user_id=? AND trashed_at IS NOT NULL`, id, u.ID)
		if rowsAffected(res, err) == 1 {
			a.removeBlobs(id)
			removed++
		}
	}
	if removed > 0 {
		a.changed(u.ID, tTrash)
	}
	writeJSON(w, 200, map[string]int{"removed": removed})
}

func (a *App) purgeExpiredTrash() {
	cutoff := a.now().Add(-trashRetention).Unix()
	rows, err := a.db.Query(`SELECT id,user_id FROM items WHERE trashed_at IS NOT NULL AND trashed_at < ?`, cutoff)
	if err != nil {
		return
	}
	var ids, users []string
	for rows.Next() {
		var id, user string
		if rows.Scan(&id, &user) == nil {
			ids, users = append(ids, id), append(users, user)
		}
	}
	rows.Close()
	for i, id := range ids {
		// the condition again: the item may have been restored from the trash since the select
		res, err := a.db.Exec(`DELETE FROM items WHERE id=? AND trashed_at IS NOT NULL AND trashed_at < ?`, id, cutoff)
		if rowsAffected(res, err) == 1 {
			a.removeBlobs(id)
			a.changed(users[i], tTrash)
		}
	}
	if len(ids) > 0 {
		log.Printf("purged %d items from the trash after %d days", len(ids), int(trashRetention.Hours()/24))
	}
}

// sweepOrphans removes blob directories that no items row refers to (left behind by a write that raced with a
// delete, or by a crash). A grace period spares directories of uploads that are still being written.
// sweepTemps removes the half-written files (.tmp-*) that a crash left in item directories: any made before this
// process started belongs to no upload. Run once at startup.
func (a *App) sweepTemps(started time.Time) {
	tmps, _ := filepath.Glob(filepath.Join(a.dataDir, "blobs", "*", "*", ".tmp-*"))
	for _, p := range tmps {
		if fi, err := os.Lstat(p); err == nil && fi.ModTime().Before(started) {
			os.Remove(p)
		}
	}
}

func (a *App) sweepOrphans() {
	root := filepath.Join(a.dataDir, "blobs")
	shards, err := os.ReadDir(root)
	if err != nil {
		return
	}
	removed := 0
	for _, sh := range shards {
		dirs, err := os.ReadDir(filepath.Join(root, sh.Name()))
		if err != nil {
			continue
		}
		for _, d := range dirs {
			id := d.Name()
			if !d.IsDir() || !idRe.MatchString(id) {
				continue
			}
			info, err := d.Info()
			if err != nil || a.now().Sub(info.ModTime()) < orphanGrace {
				continue
			}
			if a.itemGone(id) {
				os.RemoveAll(filepath.Join(root, sh.Name(), id))
				removed++
			}
		}
	}
	if removed > 0 {
		log.Printf("removed %d orphaned blob directories", removed)
	}
}
