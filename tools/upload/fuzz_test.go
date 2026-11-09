package main

import (
	"bytes"
	"math"
	"testing"
	"time"
)

// The photos and videos the tool reads are untrusted: the metadata parsers must turn any bytes into an answer or
// an error, never a panic or a runaway read. `go test` runs the seeds; `go test -fuzz=Name` explores.

func FuzzReadExif(f *testing.F) {
	tb, jpg, png, webp, heic := exifSamples()
	for _, s := range [][]byte{tb, jpg, png, webp, heic, heic[:len(heic)/2], []byte("not an image at all")} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		x, err := readExif(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return
		}
		if x.HasGPS && (math.IsNaN(x.Lat) || math.IsNaN(x.Lon)) {
			t.Fatalf("GPS position %v, %v", x.Lat, x.Lon)
		}
		if ts, local, ok := x.captureTime(time.UTC); ok && (ts.IsZero() || local.Year() < 1900) {
			t.Fatalf("capture time %v / %v from %q %q", ts, local, x.DateTime, x.Offset)
		}
	})
}

func FuzzReadVideo(f *testing.F) {
	mov := videoSample()
	f.Add(mov)
	f.Add(mov[:len(mov)-40])
	f.Add(bmff("moov", bmff("mvhd", []byte{1, 0, 0, 0})))
	f.Add([]byte{})
	f.Add(movie(false, xyzBox("+47.3769+008.5417+408.000/")))
	f.Add(movie(true, appleMeta("+47.3769+008.5417/", false)))
	f.Add(movie(true, appleMeta("-33.9249+018.4241/", true)))
	f.Fuzz(func(t *testing.T, data []byte) {
		v, err := readVideo(bytes.NewReader(data), int64(len(data)))
		if err == nil && (v.Width < 0 || v.Height < 0 || math.IsNaN(v.Duration)) {
			t.Fatalf("%+v", v)
		}
		if err == nil && v.HasGPS && !validPosition(v.Lat, v.Lon) {
			t.Fatalf("GPS position %v, %v", v.Lat, v.Lon)
		}
	})
}

func FuzzParseISO6709(f *testing.F) {
	for _, s := range []string{"+47.3769+008.5417+408.000/", "+47.3769+008.5417/", "-33.9249+018.4241/", "+00.0+000.0/", "+4722.61+00832.50/", ""} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		if lat, lon, ok := parseISO6709(b); ok && !validPosition(lat, lon) {
			t.Fatalf("%q gave %v, %v", b, lat, lon)
		}
	})
}

func validPosition(lat, lon float64) bool {
	return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat == 0 && lon == 0)
}

func FuzzPadUnpad(f *testing.F) {
	f.Add([]byte(`{"name":"a.jpg"}`), 256)
	f.Add([]byte{}, 1)
	f.Add([]byte{0x80, 0, 0}, 16)
	f.Fuzz(func(t *testing.T, b []byte, block int) {
		if block <= 0 || block > 1<<16 {
			return
		}
		p := pad(b, block)
		if len(p)%block != 0 || len(p) <= len(b) {
			t.Fatalf("pad(%d bytes, %d) = %d bytes", len(b), block, len(p))
		}
		got, err := unpad(p)
		if err != nil || !bytes.Equal(got, b) {
			t.Fatalf("unpad(pad(%x)) = %x, %v", b, got, err)
		}
		unpad(b)
	})
}
