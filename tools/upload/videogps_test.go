package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// xyzBox is Android's location atom: text length, language, ISO 6709 text.
func xyzBox(s string) []byte {
	return bmff("udta", bmff("\xa9xyz", binary.BigEndian.AppendUint16(nil, uint16(len(s))), []byte{0x15, 0xc7}, []byte(s)))
}

// appleMeta is the iPhone's keys + ilst metadata with the location as its second key. fullBox adds the version and
// flags an ISO-style meta box has; the iPhone's QuickTime-style one has none.
func appleMeta(s string, fullBox bool) []byte {
	key := func(name string) []byte { return append(append(be32(8+len(name)), "mdta"...), name...) }
	keys := bmff("keys", be32(0), be32(2), key("com.apple.quicktime.make"), key(appleLocationKey))
	value := func(idx int, v string) []byte {
		return bmff(string(be32(idx)), bmff("data", be32(1), be32(0), []byte(v)))
	}
	ilst := bmff("ilst", value(1, "Apple"), value(2, s))
	hdlr := bmff("hdlr", make([]byte, 8), []byte("mdta"), make([]byte, 13))
	var pre []byte
	if fullBox {
		pre = be32(0)
	}
	return bmff("meta", pre, hdlr, keys, ilst)
}

// movie is ftyp, a little mdat and moov with the given children, the movie box first or last.
func movie(moovFirst bool, children ...[]byte) []byte {
	ftyp := bmff("ftyp", []byte("qt  "), be32(0))
	mdat := bmff("mdat", make([]byte, 100))
	moov := bmff("moov", children...)
	if moovFirst {
		return bytes.Join([][]byte{ftyp, moov, mdat}, nil)
	}
	return bytes.Join([][]byte{ftyp, mdat, moov}, nil)
}

func gpsOf(t *testing.T, data []byte) (float64, float64, bool) {
	t.Helper()
	v, err := readVideo(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	return v.Lat, v.Lon, v.HasGPS
}

func TestVideoGPSFromBothForms(t *testing.T) {
	// a 64-bit mdat (size 1, then the real size) before the movie box, as cameras write for long recordings
	large := append(append(be32(1), "mdat"...), binary.BigEndian.AppendUint64(nil, 16+50)...)
	large = append(large, make([]byte, 50)...)
	// a movie box with size 0 runs to the end of the file
	open := append(append(be32(0), "moov"...), xyzBox("-33.9249+018.4241/")...)
	cases := []struct {
		name     string
		data     []byte
		lat, lon float64
	}{
		{"android, moov last", movie(false, xyzBox("+47.3769+008.5417/")), 47.3769, 8.5417},
		{"android, moov first", movie(true, xyzBox("+47.3769+008.5417+408.000/")), 47.3769, 8.5417},
		{"android, southern and eastern", movie(false, xyzBox("-33.9249+018.4241/")), -33.9249, 18.4241},
		{"iphone, moov last", movie(false, appleMeta("+47.3769+008.5417+408.000/", false)), 47.3769, 8.5417},
		{"iphone, moov first", movie(true, appleMeta("+40.6892-074.0445+010.000/", false)), 40.6892, -74.0445},
		{"iso meta full box", movie(false, appleMeta("+51.5007-000.1246/", true)), 51.5007, -0.1246},
		{"meta inside udta", movie(false, bmff("udta", appleMeta("+35.6586+139.7454/", false))), 35.6586, 139.7454},
		{"after a 64-bit box", append(append(bmff("ftyp", []byte("isom"), be32(0)), large...), bmff("moov", xyzBox("+01.5+002.5/"))...), 1.5, 2.5},
		{"moov to end of file", append(bmff("ftyp", []byte("isom"), be32(0)), open...), -33.9249, 18.4241},
	}
	for _, c := range cases {
		lat, lon, ok := gpsOf(t, c.data)
		if !ok || lat != c.lat || lon != c.lon {
			t.Errorf("%s: %v, %v, %v; want %v, %v", c.name, lat, lon, ok, c.lat, c.lon)
		}
	}
}

func TestVideoGPSIgnoresWhatIsNotAPosition(t *testing.T) {
	notLocation := bytes.Replace(appleMeta("+47.3769+008.5417/", false), []byte(appleLocationKey), []byte("com.apple.quicktime.location.XXXXXXX"), 1)
	binaryData := bytes.Replace(appleMeta("+47.3769+008.5417/", false), append(be32(1), be32(0)...), append(be32(0), be32(0)...), 2)
	cases := map[string][]byte{
		"no location":            videoSample(),
		"null island":            movie(false, xyzBox("+00.0000+000.0000/")),
		"latitude out of range":  movie(false, xyzBox("+91.0000+008.5417/")),
		"longitude out of range": movie(false, xyzBox("+47.0000+180.5000/")),
		"degrees and minutes":    movie(false, xyzBox("+4722.61+00832.50/")),
		"no sign":                movie(false, xyzBox("47.3769+008.5417/")),
		"trailing junk":          movie(false, xyzBox("+47.3769+008.5417x/")),
		"bare point":             movie(false, xyzBox("+47.+008.5417/")),
		"empty":                  movie(false, xyzBox("")),
		"other key":              movie(false, notLocation),
		"not text":               movie(false, binaryData),
	}
	for name, data := range cases {
		if lat, lon, ok := gpsOf(t, data); ok {
			t.Errorf("%s: got %v, %v", name, lat, lon)
		}
	}
	// a text length past the atom's end reads only what is there
	long := bmff("udta", bmff("\xa9xyz", []byte{0xff, 0xff, 0x15, 0xc7}, []byte("+47.3769+008.5417/")))
	if lat, _, ok := gpsOf(t, movie(false, long)); !ok || lat != 47.3769 {
		t.Errorf("long length: %v %v", lat, ok)
	}
}

func TestVideoGPSCutShortNeverPanics(t *testing.T) {
	for _, full := range [][]byte{movie(false, xyzBox("+47.3769+008.5417/")), movie(true, appleMeta("+47.3769+008.5417/", true))} {
		for i := 0; i <= len(full); i++ {
			readVideo(bytes.NewReader(full[:i]), int64(i))
		}
		// box sizes that lie: every 32-bit word in turn claims to be huge, tiny or a 64-bit size
		for i := 0; i+4 <= len(full); i += 4 {
			for _, v := range []uint32{0, 1, 7, 0xffffffff} {
				b := bytes.Clone(full)
				binary.BigEndian.PutUint32(b[i:], v)
				readVideo(bytes.NewReader(b), int64(len(b)))
			}
		}
	}
}

func TestParseISO6709(t *testing.T) {
	good := map[string][2]float64{
		"+47.3769+008.5417+408.000/": {47.3769, 8.5417},
		"+47.3769+008.5417/":         {47.3769, 8.5417},
		"-33.9249+018.4241/":         {-33.9249, 18.4241},
		"+47.3769+008.5417":          {47.3769, 8.5417},
		"+47+008/":                   {47, 8},
		"-90.0000-180.0000/":         {-90, -180},
		"+12.5-045.25CRSWGS_84/":     {12.5, -45.25},
		"+47.3769+008.5417/\x00":     {47.3769, 8.5417},
	}
	for s, want := range good {
		lat, lon, ok := parseISO6709([]byte(s))
		if !ok || lat != want[0] || lon != want[1] {
			t.Errorf("%q: %v, %v, %v", s, lat, lon, ok)
		}
	}
	for _, s := range []string{"", "+", "+47.3769", "+47.3769+08.5417/", "+NaN+008.5417/", "+4.3769+008.5417/", "+47.3769+008.5417 /",
		"+47.3769e5+008.5417/", "+47.37690000000000000001+008.5417/", "-00.0+000.0/", "+90.0001+000.0001/"} {
		if lat, lon, ok := parseISO6709([]byte(s)); ok {
			t.Errorf("%q accepted as %v, %v", s, lat, lon)
		}
	}
}

// The position ends up in the item's metadata as "gps", exactly like a photo's.
func TestVideoGPSInMeta(t *testing.T) {
	p := filepath.Join(t.TempDir(), "clip.mp4")
	data := movie(false, xyzBox("+47.3769+008.5417/"))
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	fi := readInfo(&localFile{Path: p, Name: "clip.mp4", Size: int64(len(data)), MTime: time.Now(), Mime: "video/mp4", Kind: "video"})
	j, _ := json.Marshal(fi.Meta)
	if !strings.Contains(string(j), `"gps":{"lat":47.3769,"lon":8.5417}`) {
		t.Fatalf("%s", j)
	}
}
