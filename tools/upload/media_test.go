package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// tiffBlock builds a little-endian TIFF with make, model, orientation 6, a capture date with offset and a GPS position.
func tiffBlock() []byte {
	type ent struct {
		tag, typ uint16
		count    uint32
		data     []byte
	}
	le := binary.LittleEndian
	str := func(s string) []byte { return append([]byte(s), 0) }
	rat := func(vals ...[2]uint32) []byte {
		var b []byte
		for _, v := range vals {
			b = le.AppendUint32(b, v[0])
			b = le.AppendUint32(b, v[1])
		}
		return b
	}
	var out bytes.Buffer
	out.Write([]byte("II*\x00"))
	out.Write(le.AppendUint32(nil, 8))
	// lay out three IFDs one after the other, then the out-of-line values
	ifds := [][]ent{
		{{0x010F, 2, 6, str("Apple")}, {0x0110, 2, 10, str("iPhone 15")}, {0x0112, 3, 1, le.AppendUint16(nil, 6)}, {0x8769, 4, 1, nil}, {0x8825, 4, 1, nil}},
		{{0x9003, 2, 20, str("2024:07:14 18:22:05")}, {0x9011, 2, 7, str("+02:00")}},
		{{1, 2, 2, str("N")}, {2, 5, 3, rat([2]uint32{47, 1}, [2]uint32{22, 1}, [2]uint32{1200, 100})}, {3, 2, 2, str("E")}, {4, 5, 3, rat([2]uint32{8, 1}, [2]uint32{32, 1}, [2]uint32{0, 1})}},
	}
	size := func(e []ent) int { return 2 + 12*len(e) + 4 }
	offs := []int{8}
	for i := 1; i < len(ifds); i++ {
		offs = append(offs, offs[i-1]+size(ifds[i-1]))
	}
	extra := offs[len(offs)-1] + size(ifds[len(ifds)-1])
	ifds[0][3].data = le.AppendUint32(nil, uint32(offs[1]))
	ifds[0][4].data = le.AppendUint32(nil, uint32(offs[2]))
	var tail bytes.Buffer
	for _, ifd := range ifds {
		out.Write(le.AppendUint16(nil, uint16(len(ifd))))
		for _, e := range ifd {
			out.Write(le.AppendUint16(nil, e.tag))
			out.Write(le.AppendUint16(nil, e.typ))
			out.Write(le.AppendUint32(nil, e.count))
			if len(e.data) <= 4 {
				v := make([]byte, 4)
				copy(v, e.data)
				out.Write(v)
			} else {
				out.Write(le.AppendUint32(nil, uint32(extra+tail.Len())))
				tail.Write(e.data)
			}
		}
		out.Write([]byte{0, 0, 0, 0})
	}
	out.Write(tail.Bytes())
	return out.Bytes()
}

func checkExif(t *testing.T, label string, data []byte) {
	t.Helper()
	x, err := readExif(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	if x.Make != "Apple" || x.Model != "iPhone 15" || x.Orientation != 6 {
		t.Fatalf("%s: %+v", label, x)
	}
	ts, local, ok := x.captureTime(time.UTC)
	if !ok || !ts.Equal(time.Date(2024, 7, 14, 16, 22, 5, 0, time.UTC)) || !local.Equal(time.Date(2024, 7, 14, 18, 22, 5, 0, time.UTC)) {
		t.Fatalf("%s: capture %v / %v", label, ts, local)
	}
	if !x.HasGPS || math.Abs(x.Lat-(47+22/60.0+12/3600.0)) > 1e-9 || math.Abs(x.Lon-(8+32/60.0)) > 1e-9 {
		t.Fatalf("%s: gps %v %v", label, x.Lat, x.Lon)
	}
}

func be32(v int) []byte { return binary.BigEndian.AppendUint32(nil, uint32(v)) }

func bmff(typ string, payload ...[]byte) []byte {
	body := bytes.Join(payload, nil)
	return append(append(be32(8+len(body)), typ...), body...)
}

func TestExifFromEveryContainer(t *testing.T) {
	tb := tiffBlock()
	checkExif(t, "tiff", tb)

	app1 := append([]byte("Exif\x00\x00"), tb...)
	jpg := append([]byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xE1}, binary.BigEndian.AppendUint16(nil, uint16(len(app1)+2))...)
	jpg = append(append(jpg, app1...), 0xFF, 0xD9)
	checkExif(t, "jpeg", jpg)

	png := []byte("\x89PNG\r\n\x1a\n")
	png = append(append(append(png, be32(13)...), "IHDR"...), make([]byte, 13+4)...)
	png = append(append(append(png, be32(len(tb))...), "eXIf"...), tb...)
	png = append(png, 0, 0, 0, 0)
	checkExif(t, "png", png)

	chunk := append([]byte("EXIF"), binary.LittleEndian.AppendUint32(nil, uint32(len(app1)))...)
	chunk = append(chunk, app1...)
	if len(app1)%2 == 1 {
		chunk = append(chunk, 0)
	}
	webp := append(append([]byte("RIFF"), binary.LittleEndian.AppendUint32(nil, uint32(4+len(chunk)))...), "WEBP"...)
	webp = append(append(webp, []byte("VP8X\x0a\x00\x00\x00")...), make([]byte, 10)...)
	webp = append(webp, chunk...)
	checkExif(t, "webp", webp)

	// HEIC: ftyp, meta { hdlr, iinf { infe(1, "Exif") }, iloc (item 1 → the Exif bytes in mdat) }, mdat
	item := append(be32(6), append([]byte("Exif\x00\x00"), tb...)...)
	ftyp := bmff("ftyp", []byte("heic"), be32(0), []byte("mif1heic"))
	infe := bmff("infe", []byte{2, 0, 0, 0}, []byte{0, 1}, []byte{0, 0}, []byte("Exif"), []byte{0})
	iinf := bmff("iinf", []byte{0, 0, 0, 0}, []byte{0, 1}, infe)
	ilocFor := func(off int) []byte {
		return bmff("iloc", []byte{0, 0, 0, 0}, []byte{0x44, 0x00}, []byte{0, 1}, []byte{0, 1}, []byte{0, 0}, []byte{0, 1}, be32(off), be32(len(item)))
	}
	meta := func(off int) []byte {
		return bmff("meta", []byte{0, 0, 0, 0}, bmff("hdlr", make([]byte, 24)), iinf, ilocFor(off))
	}
	start := len(ftyp) + len(meta(0)) + 8
	heic := append(append(ftyp, meta(start)...), bmff("mdat", item)...)
	checkExif(t, "heic", heic)

	if _, err := readExif(bytes.NewReader([]byte("not an image at all")), 19); err == nil {
		t.Fatal("garbage parsed")
	}
	// cut short anywhere: never a panic
	for i := 0; i < len(heic); i += 7 {
		readExif(bytes.NewReader(heic[:i]), int64(i))
		readExif(bytes.NewReader(jpg[:min(i, len(jpg))]), int64(min(i, len(jpg))))
	}
}

func TestVideoHeader(t *testing.T) {
	created := time.Date(2023, 12, 24, 17, 0, 0, 0, time.UTC)
	mvhd := append([]byte{0, 0, 0, 0}, be32(int(created.Unix()+2082844800))...)
	mvhd = append(append(append(append(mvhd, be32(0)...), be32(600)...), be32(600*12)...), make([]byte, 80)...)
	tkhd := make([]byte, 84)
	binary.BigEndian.PutUint32(tkhd[40:], 0)
	binary.BigEndian.PutUint32(tkhd[44:], 1<<16) // 90° rotation matrix: a=0, b=1
	binary.BigEndian.PutUint32(tkhd[76:], 1920<<16)
	binary.BigEndian.PutUint32(tkhd[80:], 1080<<16)
	mov := append(bmff("ftyp", []byte("qt  "), be32(0)), bmff("mdat", make([]byte, 100))...)
	mov = append(mov, bmff("moov", bmff("mvhd", mvhd), bmff("trak", bmff("tkhd", tkhd)))...)
	v, err := readVideo(bytes.NewReader(mov), int64(len(mov)))
	if err != nil {
		t.Fatal(err)
	}
	if !v.Created.Equal(created) || v.Width != 1080 || v.Height != 1920 || v.Duration != 12 {
		t.Fatalf("%+v", v)
	}
}

func TestScanPicksMediaAndSkipsHidden(t *testing.T) {
	d := t.TempDir()
	for _, p := range []string{"a.JPG", "b.heic", "sub/c.mov", "sub/deeper/d.dng", "notes.txt", ".hidden.jpg", ".DS_Store", ".git/e.jpg", "f.webp", "g.MP4"} {
		os.MkdirAll(filepath.Join(d, filepath.Dir(p)), 0o700)
		os.WriteFile(filepath.Join(d, p), []byte("x"), 0o600)
	}
	files, _, err := scan(d)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, f := range files {
		got = append(got, f.Rel+"="+f.Kind)
	}
	want := "[a.JPG=image b.heic=image f.webp=image g.MP4=video sub/c.mov=video sub/deeper/d.dng=image]"
	if s := "[" + strings.Join(got, " ") + "]"; s != want {
		t.Fatalf("got %s\nwant %s", s, want)
	}
}

func TestStateSurvivesReopenAndCrashedLines(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	s, err := openState(p)
	if err != nil {
		t.Fatal(err)
	}
	s.put(stateEntry{Key: "a", ID: "1", Wrapped: "w"})
	s.put(stateEntry{Key: "b", ID: "2", Wrapped: "w"})
	s.put(stateEntry{Key: "a", ID: "1", Done: true})
	s.put(stateEntry{Key: "b", Forget: true})
	s.close()
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o600)
	f.Write([]byte(`{"k":"c","id":"3"`)) // cut short
	f.Close()
	s, err = openState(p)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	if e, ok := s.get("a"); !ok || !e.Done || e.Wrapped != "" {
		t.Fatalf("a: %+v", e)
	}
	if _, ok := s.get("b"); ok {
		t.Fatal("forgotten entry came back")
	}
	if _, ok := s.get("c"); ok {
		t.Fatal("broken line was read")
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("resume file mode %v", fi.Mode().Perm())
	}
}

// countingReaderAt counts the reads a parser makes.
type countingReaderAt struct {
	r *bytes.Reader
	n int
}

func (c *countingReaderAt) ReadAt(p []byte, off int64) (int, error) { c.n++; return c.r.ReadAt(p, off) }

func TestJpegFillBytesAreSkippedInBlocks(t *testing.T) {
	app1 := append([]byte("Exif\x00\x00"), tiffBlock()...)
	jpg := append([]byte{0xFF, 0xD8}, bytes.Repeat([]byte{0xFF}, 100000)...)
	jpg = append(append(jpg, 0xE1), binary.BigEndian.AppendUint16(nil, uint16(len(app1)+2))...)
	jpg = append(append(jpg, app1...), 0xFF, 0xD9)
	r := &countingReaderAt{r: bytes.NewReader(jpg)}
	if _, err := jpegExif(r, int64(len(jpg))); err != nil {
		t.Fatalf("EXIF after fill bytes not found: %v", err)
	}
	if r.n > 100 {
		t.Fatalf("%d reads for one run of fill bytes", r.n)
	}
}

func TestIlocWithEmptyExtentsIsQuick(t *testing.T) {
	// version 0, every size 0, 65535 items with 65535 extents each: nothing to read per extent
	b := []byte{0, 0, 0, 0, 0x00, 0x00, 0xFF, 0xFF}
	for i := 0; i < 0xFFFF; i++ {
		b = append(b, 0, 2, 0, 0, 0xFF, 0xFF)
	}
	start := time.Now()
	if _, err := ilocFind(b, 1); err == nil {
		t.Fatal("no item 1, yet an offset was found")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("took %v", d)
	}
	// extents that claim more bytes than the box holds
	if _, err := ilocFind([]byte{0, 0, 0, 0, 0x44, 0x00, 0, 1, 0, 1, 0, 0, 0xFF, 0xFF, 0, 0, 0, 0}, 1); err == nil {
		t.Fatal("extents past the end accepted")
	}
}

func TestShortHeifInfoBoxIsNoExifNotACrash(t *testing.T) {
	// a 62-byte HEIC whose iinf box claims version 1 but holds only 6 bytes
	raw, _ := hex.DecodeString("000000146674797068656963000000006d6966310000002a6d657461000000000000000e69696e6601000000000000000010696c6f630000000000000000")
	if _, err := readExif(bytes.NewReader(raw), int64(len(raw))); err == nil {
		t.Fatal("expected no EXIF")
	}
}

func TestWeakServerHashingSettingsAreRefused(t *testing.T) {
	for _, p := range []kdfParams{{Ops: 1, Mem: 64 << 20}, {Ops: 3, Mem: 8 << 10}, {Ops: 3, Mem: 2 << 30}} {
		p.Alg, p.V, p.Salt = "argon2id13", 1, b64.EncodeToString(randBytes(16))
		if _, _, err := deriveFromPassword("pw", p); err == nil {
			t.Fatalf("accepted %+v", p)
		}
	}
}

func TestScanMessagesCarryNoControlCharacters(t *testing.T) {
	root := t.TempDir()
	bad := filepath.Join(root, "a\x1b]0;TITLE\a\x1b[2K")
	if err := os.Mkdir(bad, 0o000); err != nil {
		t.Skip("cannot create the directory here")
	}
	defer os.Chmod(bad, 0o700)
	r, w, _ := os.Pipe()
	old := os.Stderr
	os.Stderr = w
	scan(root)
	w.Close()
	os.Stderr = old
	out, _ := io.ReadAll(r)
	for i, c := range out {
		if c < 0x20 && !(c == '\n' && i == len(out)-1) && c != '\n' {
			t.Fatalf("control character %#x in %q", c, out)
		}
	}
}
