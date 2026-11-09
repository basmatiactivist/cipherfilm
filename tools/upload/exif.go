package main

// A small, defensive EXIF reader: the capture time (with its offset), camera make and model, orientation and GPS
// position, from JPEG, TIFF/DNG, HEIC/HEIF, PNG and WebP files. It reads only what it needs and gives up quietly on
// anything malformed; the caller then falls back to the file's date, as the web app does.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"strings"
	"time"
)

type exifInfo struct {
	DateTime    string // "2006:01:02 15:04:05" (DateTimeOriginal, else CreateDate)
	Offset      string // "+02:00" (OffsetTimeOriginal, else OffsetTime)
	Make, Model string
	Orientation int
	HasGPS      bool
	Lat, Lon    float64
}

// captureTime turns the EXIF date into a time. With an offset it is exact; without one it is read as local time on
// this Mac, which is what the browser does too.
func (e *exifInfo) captureTime(loc *time.Location) (t time.Time, local time.Time, ok bool) {
	s := strings.TrimRight(strings.TrimSpace(e.DateTime), "\x00")
	if len(s) < 19 {
		return time.Time{}, time.Time{}, false
	}
	local, err := time.ParseInLocation("2006:01:02 15:04:05", s[:19], loc)
	if err != nil || local.Year() < 1900 {
		return time.Time{}, time.Time{}, false
	}
	t = local
	if off := strings.TrimSpace(strings.TrimRight(e.Offset, "\x00")); len(off) == 6 {
		if z, err := time.Parse("2006:01:02 15:04:05-07:00", s[:19]+off); err == nil {
			t = z
		}
	}
	return t, local, true
}

const exifReadLimit = 64 << 20 // never read more than this much of a file looking for metadata

var errNoExif = errors.New("no exif")

// readExif finds the TIFF block of a file and parses it.
func readExif(r io.ReaderAt, size int64) (*exifInfo, error) {
	head := make([]byte, 16)
	if n, _ := r.ReadAt(head, 0); n < 12 {
		return nil, errNoExif
	}
	var off int64
	var err error
	switch {
	case head[0] == 0xFF && head[1] == 0xD8:
		off, err = jpegExif(r, size)
	case bytes.HasPrefix(head, []byte("II*\x00")) || bytes.HasPrefix(head, []byte("MM\x00*")):
		off = 0
	case bytes.Equal(head[4:8], []byte("ftyp")):
		off, err = heifExif(r, size)
	case bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
		off, err = pngExif(r, size)
	case bytes.HasPrefix(head, []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WEBP")):
		off, err = webpExif(r, size)
	default:
		return nil, errNoExif
	}
	if err != nil {
		return nil, err
	}
	return parseTIFF(io.NewSectionReader(r, off, min(size-off, exifReadLimit)))
}

func jpegExif(r io.ReaderAt, size int64) (int64, error) {
	pos := int64(2)
	h := make([]byte, 4)
	fill := make([]byte, 4096)
	for pos+4 <= min(size, exifReadLimit) {
		if _, err := r.ReadAt(h, pos); err != nil {
			return 0, errNoExif
		}
		if h[0] != 0xFF {
			return 0, errNoExif
		}
		marker := h[1]
		if marker == 0xFF { // a run of fill bytes: skip it a block at a time, not one read per byte
			for pos++; pos < min(size, exifReadLimit); {
				k, _ := r.ReadAt(fill, pos)
				i := 0
				for i < k && fill[i] == 0xFF {
					i++
				}
				pos += int64(i)
				if i < k || k == 0 {
					break
				}
			}
			pos-- // the last 0xFF starts the next marker
			continue
		}
		if marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01 {
			pos += 2
			continue
		}
		if marker == 0xDA || marker == 0xD9 { // image data starts: no EXIF before it
			return 0, errNoExif
		}
		l := int64(binary.BigEndian.Uint16(h[2:]))
		if marker == 0xE1 && l >= 8 {
			sig := make([]byte, 6)
			if _, err := r.ReadAt(sig, pos+4); err == nil && string(sig) == "Exif\x00\x00" {
				return pos + 10, nil
			}
		}
		pos += 2 + l
	}
	return 0, errNoExif
}

type box struct {
	typ        string
	start, end int64 // payload
}

// boxes lists the ISO-BMFF boxes in [from, to).
func boxes(r io.ReaderAt, from, to int64) []box {
	var out []box
	h := make([]byte, 16)
	for pos := from; pos+8 <= to && len(out) < 4096; {
		if _, err := r.ReadAt(h[:8], pos); err != nil {
			break
		}
		sz := int64(binary.BigEndian.Uint32(h))
		hdr := int64(8)
		switch sz {
		case 1:
			if _, err := r.ReadAt(h[8:16], pos+8); err != nil {
				return out
			}
			sz = int64(binary.BigEndian.Uint64(h[8:]))
			hdr = 16
		case 0:
			sz = to - pos
		}
		if sz < hdr || pos+sz > to {
			break
		}
		out = append(out, box{string(h[4:8]), pos + hdr, pos + sz})
		pos += sz
	}
	return out
}

func find(bs []box, typ string) (box, bool) {
	for _, b := range bs {
		if b.typ == typ {
			return b, true
		}
	}
	return box{}, false
}

func readAll(r io.ReaderAt, b box, limit int64) ([]byte, error) {
	if b.end-b.start > limit {
		return nil, errNoExif
	}
	buf := make([]byte, b.end-b.start)
	_, err := r.ReadAt(buf, b.start)
	return buf, err
}

// heifExif follows meta → iinf (the item of type "Exif") → iloc (where its bytes are).
func heifExif(r io.ReaderAt, size int64) (int64, error) {
	meta, ok := find(boxes(r, 0, size), "meta")
	if !ok {
		return 0, errNoExif
	}
	inner := boxes(r, meta.start+4, meta.end) // meta is a full box
	iinf, ok1 := find(inner, "iinf")
	iloc, ok2 := find(inner, "iloc")
	if !ok1 || !ok2 {
		return 0, errNoExif
	}
	ib, err := readAll(r, iinf, 1<<20)
	if err != nil || len(ib) < 6 {
		return 0, errNoExif
	}
	p := 6 // version 0: a 16-bit entry count after version and flags
	if ib[0] != 0 {
		p = 8
	}
	if len(ib) < p { // the file decides the version byte: never slice past what it actually holds
		return 0, errNoExif
	}
	exifID := uint32(0)
	for _, e := range boxesInBytes(ib[p:]) {
		if e.typ != "infe" || len(e.data) < 12 || e.data[0] < 2 {
			continue
		}
		v := e.data[0]
		var id uint32
		q := 4
		if v == 2 {
			id = uint32(binary.BigEndian.Uint16(e.data[q:]))
			q += 2
		} else {
			id = binary.BigEndian.Uint32(e.data[q:])
			q += 4
		}
		q += 2 // protection index
		if q+4 <= len(e.data) && string(e.data[q:q+4]) == "Exif" {
			exifID = id
			break
		}
	}
	if exifID == 0 {
		return 0, errNoExif
	}
	lb, err := readAll(r, iloc, 1<<20)
	if err != nil {
		return 0, errNoExif
	}
	start, err := ilocFind(lb, exifID)
	if err != nil {
		return 0, err
	}
	pre := make([]byte, 4)
	if _, err := r.ReadAt(pre, start); err != nil {
		return 0, errNoExif
	}
	// the item starts with the offset of the TIFF header within it (after "Exif\0\0")
	return start + 4 + int64(binary.BigEndian.Uint32(pre)), nil
}

type rawBox struct {
	typ  string
	data []byte
}

func boxesInBytes(b []byte) []rawBox {
	var out []rawBox
	for len(b) >= 8 {
		sz := int(binary.BigEndian.Uint32(b))
		if sz < 8 || sz > len(b) {
			break
		}
		out = append(out, rawBox{string(b[4:8]), b[8:sz]})
		b = b[sz:]
	}
	return out
}

func ilocFind(b []byte, want uint32) (int64, error) {
	if len(b) < 8 {
		return 0, errNoExif
	}
	v := b[0]
	offSize, lenSize := int(b[4]>>4), int(b[4]&15)
	baseSize, idxSize := int(b[5]>>4), int(b[5]&15)
	if v == 0 {
		idxSize = 0
	}
	p := 6
	rd := func(n int) (uint64, bool) {
		if n == 0 {
			return 0, true
		}
		if p+n > len(b) || (n != 4 && n != 8 && n != 2) {
			return 0, false
		}
		var x uint64
		switch n {
		case 2:
			x = uint64(binary.BigEndian.Uint16(b[p:]))
		case 4:
			x = uint64(binary.BigEndian.Uint32(b[p:]))
		case 8:
			x = binary.BigEndian.Uint64(b[p:])
		}
		p += n
		return x, true
	}
	var count uint64
	var ok bool
	if v < 2 {
		count, ok = rd(2)
	} else {
		count, ok = rd(4)
	}
	if !ok {
		return 0, errNoExif
	}
	for i := uint64(0); i < count && i < 65536; i++ {
		var id uint64
		if v < 2 {
			id, ok = rd(2)
		} else {
			id, ok = rd(4)
		}
		if !ok {
			return 0, errNoExif
		}
		method := uint64(0)
		if v == 1 || v == 2 {
			if method, ok = rd(2); !ok {
				return 0, errNoExif
			}
			method &= 0xf
		}
		if _, ok = rd(2); !ok { // data reference index
			return 0, errNoExif
		}
		base, ok1 := rd(baseSize)
		n, ok2 := rd(2)
		if !ok1 || !ok2 {
			return 0, errNoExif
		}
		// the extents must fit in what is left of the box; with all their fields 0 bytes wide only the first counts
		per := uint64(idxSize + offSize + lenSize)
		if n*per > uint64(len(b)-p) {
			return 0, errNoExif
		}
		if per == 0 {
			n = min(n, 1)
		}
		var first uint64
		for e := uint64(0); e < n; e++ {
			if _, ok = rd(idxSize); !ok {
				return 0, errNoExif
			}
			off, ok1 := rd(offSize)
			_, ok2 := rd(lenSize)
			if !ok1 || !ok2 {
				return 0, errNoExif
			}
			if e == 0 {
				first = off
			}
		}
		if uint32(id) == want {
			if method != 0 || n == 0 {
				return 0, errNoExif // only plain file offsets are supported
			}
			return int64(base + first), nil
		}
	}
	return 0, errNoExif
}

func pngExif(r io.ReaderAt, size int64) (int64, error) {
	h := make([]byte, 8)
	for pos := int64(8); pos+8 <= min(size, exifReadLimit); {
		if _, err := r.ReadAt(h, pos); err != nil {
			break
		}
		l := int64(binary.BigEndian.Uint32(h))
		switch string(h[4:8]) {
		case "eXIf":
			return pos + 8, nil
		case "IDAT", "IEND":
			return 0, errNoExif
		}
		pos += 12 + l
	}
	return 0, errNoExif
}

func webpExif(r io.ReaderAt, size int64) (int64, error) {
	h := make([]byte, 8)
	for pos := int64(12); pos+8 <= min(size, exifReadLimit); {
		if _, err := r.ReadAt(h, pos); err != nil {
			break
		}
		l := int64(binary.LittleEndian.Uint32(h[4:]))
		if string(h[:4]) == "EXIF" {
			sig := make([]byte, 6)
			if _, err := r.ReadAt(sig, pos+8); err == nil && string(sig) == "Exif\x00\x00" {
				return pos + 14, nil
			}
			return pos + 8, nil
		}
		pos += 8 + l + l&1
	}
	return 0, errNoExif
}

// ---- TIFF ----

type tiff struct {
	r  io.ReaderAt
	bo binary.ByteOrder
}

type ifdEntry struct {
	tag, typ uint16
	count    uint32
	raw      [4]byte
}

var typeSize = map[uint16]int{1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}

func parseTIFF(r io.ReaderAt) (*exifInfo, error) {
	h := make([]byte, 8)
	if _, err := r.ReadAt(h, 0); err != nil {
		return nil, errNoExif
	}
	t := &tiff{r: r}
	switch string(h[:2]) {
	case "II":
		t.bo = binary.LittleEndian
	case "MM":
		t.bo = binary.BigEndian
	default:
		return nil, errNoExif
	}
	if t.bo.Uint16(h[2:]) != 42 {
		return nil, errNoExif
	}
	ifd0 := t.ifd(int64(t.bo.Uint32(h[4:])))
	if ifd0 == nil {
		return nil, errNoExif
	}
	e := &exifInfo{}
	e.Make = t.str(ifd0[0x010F])
	e.Model = t.str(ifd0[0x0110])
	if o, ok := t.uint(ifd0[0x0112]); ok {
		e.Orientation = int(o)
	}
	if p, ok := t.uint(ifd0[0x8769]); ok {
		if sub := t.ifd(int64(p)); sub != nil {
			e.DateTime = t.str(sub[0x9003])
			e.Offset = t.str(sub[0x9011])
			if e.DateTime == "" {
				e.DateTime = t.str(sub[0x9004])
				e.Offset = t.str(sub[0x9012])
			}
			if e.Offset == "" {
				e.Offset = t.str(sub[0x9010])
			}
		}
	}
	if p, ok := t.uint(ifd0[0x8825]); ok {
		if g := t.ifd(int64(p)); g != nil {
			lat, ok1 := t.degrees(g[2])
			lon, ok2 := t.degrees(g[4])
			if ok1 && ok2 {
				if strings.HasPrefix(t.str(g[1]), "S") {
					lat = -lat
				}
				if strings.HasPrefix(t.str(g[3]), "W") {
					lon = -lon
				}
				if lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat == 0 && lon == 0) {
					e.HasGPS, e.Lat, e.Lon = true, lat, lon
				}
			}
		}
	}
	return e, nil
}

func (t *tiff) ifd(off int64) map[uint16]*ifdEntry {
	nb := make([]byte, 2)
	if off <= 0 || off > exifReadLimit {
		return nil
	}
	if _, err := t.r.ReadAt(nb, off); err != nil {
		return nil
	}
	n := int(t.bo.Uint16(nb))
	if n == 0 || n > 1000 {
		return nil
	}
	buf := make([]byte, 12*n)
	if _, err := t.r.ReadAt(buf, off+2); err != nil {
		return nil
	}
	out := map[uint16]*ifdEntry{}
	for i := 0; i < n; i++ {
		b := buf[i*12:]
		e := &ifdEntry{tag: t.bo.Uint16(b), typ: t.bo.Uint16(b[2:]), count: t.bo.Uint32(b[4:])}
		copy(e.raw[:], b[8:12])
		out[e.tag] = e
	}
	return out
}

// value returns the entry's bytes, inline or at its offset.
func (t *tiff) value(e *ifdEntry, limit int) []byte {
	if e == nil {
		return nil
	}
	sz, ok := typeSize[e.typ]
	if !ok || e.count == 0 || int64(e.count)*int64(sz) > int64(limit) {
		return nil
	}
	n := int(e.count) * sz
	if n <= 4 {
		return e.raw[:n]
	}
	buf := make([]byte, n)
	if _, err := t.r.ReadAt(buf, int64(t.bo.Uint32(e.raw[:]))); err != nil {
		return nil
	}
	return buf
}

func (t *tiff) str(e *ifdEntry) string {
	if e == nil || (e.typ != 2 && e.typ != 7) {
		return ""
	}
	b := t.value(e, 256)
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	s := strings.TrimSpace(string(b))
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.ToValidUTF8(s, ""))
}

func (t *tiff) uint(e *ifdEntry) (uint32, bool) {
	b := t.value(e, 8)
	if len(b) == 0 {
		return 0, false
	}
	switch e.typ {
	case 3:
		return uint32(t.bo.Uint16(b)), true
	case 4:
		return t.bo.Uint32(b), true
	case 1, 7:
		return uint32(b[0]), true
	}
	return 0, false
}

func (t *tiff) degrees(e *ifdEntry) (float64, bool) {
	if e == nil || e.typ != 5 || e.count != 3 {
		return 0, false
	}
	b := t.value(e, 24)
	if len(b) != 24 {
		return 0, false
	}
	v := 0.0
	for i, div := range []float64{1, 60, 3600} {
		num, den := t.bo.Uint32(b[i*8:]), t.bo.Uint32(b[i*8+4:])
		if den == 0 {
			if num == 0 {
				continue
			}
			return 0, false
		}
		v += float64(num) / float64(den) / div
	}
	return v, !math.IsNaN(v) && !math.IsInf(v, 0)
}

// ---- MP4 / QuickTime ----

type videoInfo struct {
	Created       time.Time
	Width, Height int
	Duration      float64
	HasGPS        bool
	Lat, Lon      float64
}

// readVideo reads the creation time, duration, display size and place from the movie header boxes.
func readVideo(r io.ReaderAt, size int64) (*videoInfo, error) {
	moov, ok := find(boxes(r, 0, size), "moov")
	if !ok {
		return nil, errors.New("no movie header")
	}
	if moov.end-moov.start > exifReadLimit {
		return nil, errors.New("movie header too large")
	}
	v := &videoInfo{}
	inner := boxes(r, moov.start, moov.end)
	if mvhd, ok := find(inner, "mvhd"); ok {
		if b, err := readAll(r, mvhd, 4096); err == nil && len(b) >= 20 {
			var created, scale, dur uint64
			if b[0] == 1 && len(b) >= 32 {
				created, scale, dur = binary.BigEndian.Uint64(b[4:]), uint64(binary.BigEndian.Uint32(b[20:])), binary.BigEndian.Uint64(b[24:])
			} else {
				created, scale, dur = uint64(binary.BigEndian.Uint32(b[4:])), uint64(binary.BigEndian.Uint32(b[12:])), uint64(binary.BigEndian.Uint32(b[16:]))
			}
			const epoch1904 = 2082844800
			if created > epoch1904+365*24*3600 { // 0 and junk mean "unknown"
				v.Created = time.Unix(int64(created-epoch1904), 0)
			}
			if scale > 0 {
				v.Duration = math.Round(float64(dur)/float64(scale)*1000) / 1000
			}
		}
	}
	for _, trak := range inner {
		if trak.typ != "trak" {
			continue
		}
		tkhd, ok := find(boxes(r, trak.start, trak.end), "tkhd")
		if !ok {
			continue
		}
		b, err := readAll(r, tkhd, 4096)
		if err != nil || len(b) < 84 {
			continue
		}
		p := 40 // version 0: flags, times, track id, reserved, duration, reserved, layer, group, volume, reserved
		if b[0] == 1 {
			p = 52
		}
		if len(b) < p+44 {
			continue
		}
		m0, m1 := int32(binary.BigEndian.Uint32(b[p:])), int32(binary.BigEndian.Uint32(b[p+4:]))
		w, h := int(binary.BigEndian.Uint32(b[p+36:])>>16), int(binary.BigEndian.Uint32(b[p+40:])>>16)
		if w == 0 || h == 0 {
			continue // an audio track
		}
		if m0 == 0 && (m1 == 1<<16 || m1 == -(1<<16)) { // rotated by 90° or 270°
			w, h = h, w
		}
		v.Width, v.Height = w, h
		break
	}
	v.Lat, v.Lon, v.HasGPS = videoGPS(r, inner)
	return v, nil
}
