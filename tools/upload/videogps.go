package main

// Where a video was recorded, from its MP4/QuickTime header, so videos land on the map like photos do. Phones write
// it in one of two places:
//   - moov/udta/©xyz (Android's MediaMuxer and many cameras): a 16-bit length, a 16-bit language, the text
//   - moov/meta with keys + ilst (iPhone): the item whose key is com.apple.quicktime.location.ISO6709
// Both hold an ISO 6709 string such as "+47.3769+008.5417+408.000/". The file is untrusted: every read is bounded and
// anything that doesn't look exactly right is "no position", never a guess.

import (
	"bytes"
	"encoding/binary"
	"io"
	"math"
	"strconv"
)

const appleLocationKey = "com.apple.quicktime.location.ISO6709"

// videoGPS looks in the movie box's children (already listed by readVideo) for a position.
func videoGPS(r io.ReaderAt, moov []box) (lat, lon float64, ok bool) {
	udta, hasUdta := find(moov, "udta")
	var inUdta []box
	if hasUdta {
		inUdta = boxes(r, udta.start, udta.end)
		if xyz, found := find(inUdta, "\xa9xyz"); found {
			if b, err := readAll(r, xyz, 4096); err == nil && len(b) >= 4 {
				n := int(binary.BigEndian.Uint16(b))
				if lat, lon, ok = parseISO6709(b[4:min(4+n, len(b))]); ok {
					return lat, lon, true
				}
			}
		}
	}
	// the iPhone's keys live in moov/meta; some writers put the same structure in moov/udta/meta
	metas := []box{}
	if m, found := find(moov, "meta"); found {
		metas = append(metas, m)
	}
	if m, found := find(inUdta, "meta"); found {
		metas = append(metas, m)
	}
	for _, m := range metas {
		if lat, lon, ok = metaLocation(r, m); ok {
			return lat, lon, true
		}
	}
	return 0, 0, false
}

// metaLocation reads the ISO 6709 value of a keys + ilst metadata box.
func metaLocation(r io.ReaderAt, meta box) (lat, lon float64, ok bool) {
	// QuickTime's meta is a plain box, ISO's a full box with 4 bytes of version and flags first: whichever start
	// lists a handler box is the right one
	inner := boxes(r, meta.start, meta.end)
	if _, found := find(inner, "hdlr"); !found && meta.end-meta.start >= 4 {
		inner = boxes(r, meta.start+4, meta.end)
	}
	keys, ok1 := find(inner, "keys")
	ilst, ok2 := find(inner, "ilst")
	if !ok1 || !ok2 {
		return 0, 0, false
	}
	kb, err := readAll(r, keys, 64<<10)
	if err != nil || len(kb) < 8 {
		return 0, 0, false
	}
	// version and flags, an entry count, then entries of size, namespace and name; items in ilst are numbered from 1
	count := binary.BigEndian.Uint32(kb[4:])
	index := uint32(0)
	p := 8
	for i := uint32(1); i <= count && p+8 <= len(kb); i++ {
		sz := int(binary.BigEndian.Uint32(kb[p:]))
		if sz < 8 || sz > len(kb)-p {
			return 0, 0, false
		}
		if string(kb[p+4:p+8]) == "mdta" && string(kb[p+8:p+sz]) == appleLocationKey {
			index = i
			break
		}
		p += sz
	}
	if index == 0 {
		return 0, 0, false
	}
	for _, item := range boxes(r, ilst.start, ilst.end) {
		if binary.BigEndian.Uint32([]byte(item.typ)) != index {
			continue
		}
		ib, err := readAll(r, item, 4096)
		if err != nil {
			return 0, 0, false
		}
		for _, d := range boxesInBytes(ib) {
			// a type of 1 is UTF-8 text; then 4 bytes of locale and the value
			if d.typ == "data" && len(d.data) >= 8 && binary.BigEndian.Uint32(d.data) == 1 {
				if lat, lon, ok = parseISO6709(d.data[8:]); ok {
					return lat, lon, true
				}
			}
		}
		return 0, 0, false
	}
	return 0, 0, false
}

// parseISO6709 reads the decimal-degrees form only: sign, two digits of latitude, sign, three digits of longitude,
// each with optional decimals, then an optional altitude, coordinate system or "/". The degrees-minutes forms are
// refused rather than misread as degrees.
func parseISO6709(b []byte) (lat, lon float64, ok bool) {
	b = bytes.TrimRight(bytes.TrimSpace(b), "\x00")
	num := func(intDigits int) (float64, bool) {
		if len(b) < 1+intDigits || (b[0] != '+' && b[0] != '-') {
			return 0, false
		}
		i := 1
		for ; i < 1+intDigits; i++ {
			if b[i] < '0' || b[i] > '9' {
				return 0, false
			}
		}
		if i < len(b) && b[i] == '.' {
			j := i + 1
			for j < len(b) && b[j] >= '0' && b[j] <= '9' {
				j++
			}
			if j == i+1 || j-i > 16 { // a point needs digits after it, and no more than any device writes
				return 0, false
			}
			i = j
		}
		v, err := strconv.ParseFloat(string(b[:i]), 64)
		b = b[i:]
		return v, err == nil
	}
	lat, ok1 := num(2)
	lon, ok2 := num(3)
	if !ok1 || !ok2 {
		return 0, 0, false
	}
	// what may follow: nothing, "/", an altitude (another sign) or a coordinate system ("CRS…")
	if len(b) > 0 && b[0] != '/' && b[0] != '+' && b[0] != '-' && !bytes.HasPrefix(b, []byte("CRS")) {
		return 0, 0, false
	}
	if math.IsNaN(lat) || math.IsNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 || (lat == 0 && lon == 0) {
		return 0, 0, false
	}
	return lat, lon, true
}
