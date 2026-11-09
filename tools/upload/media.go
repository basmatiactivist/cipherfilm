package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/image/draw"
)

const (
	thumbPx         = 640 // web/src/media.ts THUMB_PX
	previewPx       = 2048
	maxFileBytes    = 8 << 30 // the server's limit per file
	maxThumbBytes   = 256 << 10
	maxPreviewBytes = 3 << 20
)

var mimeByExt = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
	".heic": "image/heic", ".heif": "image/heif", ".gif": "image/gif", ".dng": "image/x-adobe-dng",
	".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v",
}

type localFile struct {
	Path  string // absolute
	Rel   string // relative to the chosen folder, for messages
	Name  string
	Size  int64
	MTime time.Time
	Mime  string
	Kind  string // image | video
}

func (f *localFile) key() string {
	return f.Path + "\x00" + strconv.FormatInt(f.Size, 10) + "\x00" + strconv.FormatInt(f.MTime.UnixNano(), 10)
}

// scan lists the photos and videos under root (recursively), skipping hidden files and folders.
func scan(root string) (files []*localFile, tooLarge []string, err error) {
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, nil, err
	}
	if fi, err := os.Stat(root); err != nil {
		return nil, nil, err
	} else if !fi.IsDir() {
		return nil, nil, fmt.Errorf("%s is not a folder", root)
	}
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == root {
				return err
			}
			fmt.Fprintln(os.Stderr, clean(fmt.Sprintf("skipped %s: %v", p, err))) // the error repeats the raw name
			return nil
		}
		name := d.Name()
		if p != root && strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		mime, ok := mimeByExt[strings.ToLower(filepath.Ext(name))]
		if !ok {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if fi.Size() > maxFileBytes {
			tooLarge = append(tooLarge, rel)
			return nil
		}
		kind := "image"
		if strings.HasPrefix(mime, "video/") {
			kind = "video"
		}
		files = append(files, &localFile{Path: p, Rel: rel, Name: name, Size: fi.Size(), MTime: fi.ModTime(), Mime: mime, Kind: kind})
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return files[i].Rel < files[j].Rel })
	return files, tooLarge, err
}

// itemMeta is the metadata JSON of web/src/media.ts ItemMeta.
type itemMeta struct {
	Name         string   `json:"name"`
	Mime         string   `json:"mime"`
	Size         int64    `json:"size"`
	LastModified int64    `json:"lastModified"`
	CaptureTS    int64    `json:"capture_ts"`
	Width        int      `json:"width,omitempty"`
	Height       int      `json:"height,omitempty"`
	Duration     float64  `json:"duration,omitempty"`
	Make         string   `json:"make,omitempty"`
	Model        string   `json:"model,omitempty"`
	GPS          *gpsMeta `json:"gps,omitempty"`
}

type gpsMeta struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// fileInfo is what the upload needs to know about one file before it starts.
type fileInfo struct {
	Meta itemMeta
	// other capture times the web app may have recorded for the same file (local-time EXIF, the file date): a match on
	// any of them counts as a duplicate
	altCapture  []int64
	orientation int
}

// safeExif reads EXIF from an untrusted file; a parser bug ends as "no EXIF" for that file, never as the end of the run.
func safeExif(r io.ReaderAt, size int64) (x *exifInfo, err error) {
	defer func() {
		if recover() != nil {
			x, err = nil, errNoExif
		}
	}()
	return readExif(r, size)
}

// safeVideo is safeExif for a video's header.
func safeVideo(r io.ReaderAt, size int64) (v *videoInfo, err error) {
	defer func() {
		if recover() != nil {
			v, err = nil, errNoExif
		}
	}()
	return readVideo(r, size)
}

func readInfo(f *localFile) *fileInfo {
	mt := f.MTime.UnixMilli()
	fi := &fileInfo{Meta: itemMeta{Name: f.Name, Mime: f.Mime, Size: f.Size, LastModified: mt, CaptureTS: mt}}
	fi.altCapture = []int64{mt}
	h, err := os.Open(f.Path)
	if err != nil {
		return fi
	}
	defer h.Close()
	if f.Kind == "image" {
		if x, err := safeExif(h, f.Size); err == nil {
			if t, local, ok := x.captureTime(time.Local); ok {
				fi.Meta.CaptureTS = t.UnixMilli()
				fi.altCapture = append(fi.altCapture, local.UnixMilli())
			}
			fi.Meta.Make, fi.Meta.Model = x.Make, x.Model
			if x.HasGPS {
				fi.Meta.GPS = &gpsMeta{x.Lat, x.Lon}
			}
			fi.orientation = x.Orientation
		}
	} else if v, err := safeVideo(h, f.Size); err == nil {
		if !v.Created.IsZero() {
			fi.Meta.CaptureTS = v.Created.UnixMilli()
		}
		fi.Meta.Width, fi.Meta.Height, fi.Meta.Duration = v.Width, v.Height, v.Duration
		if v.HasGPS {
			fi.Meta.GPS = &gpsMeta{v.Lat, v.Lon}
		}
	}
	return fi
}

// ---- thumbnails ----

type thumbs struct{ thumb, preview []byte }

// makeThumbs renders the 640 px thumbnail and the 2048 px preview as JPEG. Images go through sips (it reads HEIC and
// DNG); videos through QuickLook (qlmanage), else ffmpeg. Without either, the file uploads without a thumbnail, as
// in the web app. It also fills in the width and height when the file did not say.
func makeThumbs(ctx context.Context, f *localFile, info *fileInfo, tmp string) (*thumbs, error) {
	dir, err := os.MkdirTemp(tmp, "t-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var src string
	if f.Kind == "image" {
		w, h := sipsSize(ctx, f.Path)
		if w > 0 && h > 0 {
			if info.orientation >= 5 && info.orientation <= 8 {
				w, h = h, w
			}
			info.Meta.Width, info.Meta.Height = w, h
		}
		src = filepath.Join(dir, "p.jpg")
		args := []string{"-s", "format", "jpeg", "-s", "formatOptions", "95"}
		if max(w, h) > previewPx || w == 0 {
			args = append(args, "-Z", strconv.Itoa(previewPx))
		}
		if out, err := exec.CommandContext(ctx, "sips", append(args, f.Path, "--out", src)...).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("sips: %v %s", err, strings.TrimSpace(string(out)))
		}
	} else {
		if src, err = videoFrame(ctx, f.Path, dir); err != nil {
			return nil, err
		}
	}
	raw, err := os.ReadFile(src)
	if err != nil {
		return nil, err
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	// sips may keep the orientation tag instead of turning the pixels: then turn them here, so the thumbnail looks
	// right everywhere (the JPEGs written below carry no EXIF)
	if f.Kind == "image" {
		if x, err := readExif(bytes.NewReader(raw), int64(len(raw))); err == nil && x.Orientation > 1 {
			img = orient(img, x.Orientation)
		}
	}
	b := img.Bounds()
	if f.Kind == "video" && info.Meta.Width == 0 {
		info.Meta.Width, info.Meta.Height = b.Dx(), b.Dy()
	}
	preview, err := encodeJPEG(fit(img, previewPx), 85, maxPreviewBytes)
	if err != nil {
		return nil, err
	}
	thumb, err := encodeJPEG(fit(img, thumbPx), 82, maxThumbBytes)
	if err != nil {
		return nil, err
	}
	return &thumbs{thumb, preview}, nil
}

func sipsSize(ctx context.Context, p string) (int, int) {
	out, err := exec.CommandContext(ctx, "sips", "-g", "pixelWidth", "-g", "pixelHeight", p).Output()
	if err != nil {
		return 0, 0
	}
	var w, h int
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		n, _ := strconv.Atoi(strings.TrimSpace(v))
		switch strings.TrimSpace(k) {
		case "pixelWidth":
			w = n
		case "pixelHeight":
			h = n
		}
	}
	return w, h
}

func videoFrame(ctx context.Context, p, dir string) (string, error) {
	if _, err := exec.LookPath("qlmanage"); err == nil {
		exec.CommandContext(ctx, "qlmanage", "-t", "-s", strconv.Itoa(previewPx), "-o", dir, p).Run()
		if m, _ := filepath.Glob(filepath.Join(dir, "*.png")); len(m) > 0 {
			return m[0], nil
		}
	}
	if _, err := exec.LookPath("ffmpeg"); err == nil {
		out := filepath.Join(dir, "frame.jpg")
		for _, at := range []string{"1", "0"} { // a second in, else the first frame (very short clips)
			// read as the MP4/MOV the extension says it is, from the local file only
			cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-protocol_whitelist", "file",
				"-f", "mov", "-ss", at, "-i", "file:"+p, "-frames:v", "1",
				"-vf", fmt.Sprintf("scale='min(%d,iw)':-2", previewPx), "-q:v", "2", out)
			if cmd.Run() == nil {
				if fi, err := os.Stat(out); err == nil && fi.Size() > 0 {
					return out, nil
				}
			}
		}
	}
	return "", errors.New("no video frame (QuickLook could not read it and ffmpeg is not installed)")
}

func fit(img image.Image, maxPx int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if max(w, h) <= maxPx {
		return img
	}
	scale := float64(maxPx) / float64(max(w, h))
	nw, nh := max(1, int(float64(w)*scale+0.5)), max(1, int(float64(h)*scale+0.5))
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst
}

// encodeJPEG lowers the quality until the result fits the server's limit.
func encodeJPEG(img image.Image, q, limit int) ([]byte, error) {
	for ; q >= 40; q -= 10 {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
			return nil, err
		}
		if buf.Len() <= limit {
			return buf.Bytes(), nil
		}
	}
	return nil, errors.New("thumbnail too large")
}

// orient applies an EXIF orientation (2-8) to the pixels.
func orient(src image.Image, o int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			default:
				dx, dy = x, y
			}
			dst.Set(dx, dy, src.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}
