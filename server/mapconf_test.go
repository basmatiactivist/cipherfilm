package main

import (
	"os"
	"strings"
	"testing"
)

// MAP_STYLE: the default base map, none, or the operator's own; anything else stops the start.
func TestMapSetting(t *testing.T) {
	if m, err := mapSetting(""); err != nil || m != defaultMap {
		t.Fatalf("default: %v %v", m, err)
	}
	if m, err := mapSetting(" OFF "); err != nil || m != nil {
		t.Fatalf("off: %v %v", m, err)
	}
	m, err := mapSetting("https://maps.example.org/light.json https://maps.example.org/dark.json")
	if err != nil || m.Light[0] != "https://maps.example.org/light.json" || m.Dark[0] != "https://maps.example.org/dark.json" {
		t.Fatalf("own: %v %v", m, err)
	}
	if o := m.origins(); len(o) != 1 || o[0] != "https://maps.example.org" {
		t.Fatalf("origins: %v", o)
	}
	for _, bad := range []string{"http://x.org/a http://x.org/b", "https://x.org/a", "javascript:x https://x.org/b", "https://u:p@x.org/a https://x.org/b", "a b c"} {
		if _, err := mapSetting(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if o := defaultMap.origins(); strings.Join(o, " ") != "https://tiles.openfreemap.org https://tiles.versatiles.org" {
		t.Fatalf("default origins: %v", o)
	}
}

// The apps get the map's styles at sign-in; with MAP_STYLE=off they get none, and the web app's CSP allows exactly
// the map's hosts and nothing else new.
func TestMapInTheSessionAndTheCSP(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	_, me := admin.do("GET", "/api/me", nil, false)
	mp, ok := me["map"].(map[string]any)
	if !ok || mp["light"].([]any)[0] != "https://tiles.openfreemap.org/styles/positron" {
		t.Fatalf("map: %v", me["map"])
	}
	c := buildCSP(defaultMap.origins())
	if !strings.Contains(c, "connect-src 'self' https://huggingface.co https://*.hf.co https://tiles.openfreemap.org https://tiles.versatiles.org;") || strings.Contains(c, "unsafe-inline") {
		t.Fatalf("csp: %s", c)
	}
	if c := buildCSP(nil); strings.Contains(c, "openfreemap") {
		t.Fatalf("csp without a map: %s", c)
	}

	t.Setenv("MAP_STYLE", "off")
	e2 := newEnv(t)
	admin2, _ := e2.setupAdmin("admin@x.org")
	if _, me := admin2.do("GET", "/api/me", nil, false); me["map"] != nil {
		t.Fatalf("map though off: %v", me["map"])
	}
}

// The apps call only this exact setting "OpenFreeMap" (web/src/places/mapHosts.ts, mac Me.MapStyles.provider): their
// copy of the default must stay the same as the server's.
func TestDefaultMapMatchesClients(t *testing.T) {
	for _, f := range []string{"../web/src/places/mapHosts.ts", "../mac/Sources/CipherfilmCore/MapHosts.swift"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, u := range append(append([]string{}, defaultMap.Light...), defaultMap.Dark...) {
			if !strings.Contains(string(b), `"`+u+`"`) {
				t.Errorf("%s lacks the default style %s", f, u)
			}
		}
	}
}

// The place-name file (web/src/places/places-v1.bin, a few MB) goes out gzip-compressed like the app's code.
func TestPlacesFileCompressed(t *testing.T) {
	if !compressible("assets/places-v1-abc123.bin") {
		t.Fatal("the places file is sent uncompressed")
	}
}

// A host that could add to the Content-Security-Policy is refused; a port and an IPv6 address pass.
func TestMapSettingHosts(t *testing.T) {
	for _, bad := range []string{"https://a;b.example/s.json", "https://'self'/s.json", "https://*.example.org/s.json", "https://a,b.example/s.json", "https://h.example:x/s.json"} {
		if _, err := mapSetting(bad + " https://ok.example/d.json"); err == nil {
			t.Errorf("%s was accepted", bad)
		}
	}
	m, err := mapSetting("https://maps.example.org:8443/l.json https://[2001:db8::1]/d.json")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(m.origins(), " "); got != "https://[2001:db8::1] https://maps.example.org:8443" {
		t.Errorf("origins: %s", got)
	}
}
