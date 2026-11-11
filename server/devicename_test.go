package main

import (
	"net/http/httptest"
	"testing"
)

func TestDeviceNameLabels(t *testing.T) {
	for _, c := range []struct{ ua, dev, want string }{
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "", "Chrome on macOS"},
		{"cipherfilm-upload/2.7.0", "", "Upload tool"},
		{"okhttp/4.12.0", "", "Android app"},
		{"Cipherfilm/2.7 CFNetwork/3826 Darwin/25.0.0", "", "Mac app"},
		{"okhttp/4.12.0", "Pixel 8 · Android app", "Pixel 8 · Android app"},
		{"curl/8.7.1", "", ""},
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("User-Agent", c.ua)
		if c.dev != "" {
			r.Header.Set("X-CF-Device", c.dev)
		}
		if got := deviceName(r); got != c.want {
			t.Errorf("deviceName(%q, %q) = %q, want %q", c.ua, c.dev, got, c.want)
		}
	}
}
