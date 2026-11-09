package main

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// The map tab's base map (docs/MAP.md). Photo locations are decrypted and drawn on the device; the base map's server
// only sees which map tiles a device loads (an area and a zoom), never a photo or its coordinates. MAP_STYLE picks it:
// empty for OpenFreeMap (no key, no cookies, no IPs in its access logs) with VersaTiles as the fallback, "off" for no
// map, or "LIGHT_STYLE_URL DARK_STYLE_URL" for your own (MapLibre style JSON over https, everything on that host).
type mapConfig struct {
	Light []string `json:"light"` // style URLs, tried in order
	Dark  []string `json:"dark"`
}

var defaultMap = &mapConfig{
	Light: []string{"https://tiles.openfreemap.org/styles/positron", "https://tiles.versatiles.org/assets/styles/muted/style.json"},
	Dark:  []string{"https://tiles.openfreemap.org/styles/dark", "https://tiles.versatiles.org/assets/styles/colorful-dark/style.json"},
}

// mapSetting reads MAP_STYLE; nil means no map.
func mapSetting(v string) (*mapConfig, error) {
	f := strings.Fields(v)
	switch {
	case len(f) == 0:
		return defaultMap, nil
	case len(f) == 1 && strings.EqualFold(f[0], "off"):
		return nil, nil
	case len(f) == 2:
		for _, s := range f {
			u, err := url.Parse(s)
			if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || !plainHost(u.Host) {
				return nil, fmt.Errorf("MAP_STYLE: %q is not an https URL", s)
			}
		}
		return &mapConfig{Light: f[:1], Dark: f[1:]}, nil
	}
	return nil, fmt.Errorf(`MAP_STYLE: expected nothing (OpenFreeMap), "off", or "LIGHT_STYLE_URL DARK_STYLE_URL"`)
}

// plainHost: a host name of letters, digits, dots and dashes, or an IPv6 address in brackets, with an optional port.
// The host goes into the web app's Content-Security-Policy, so nothing else may pass (no ';', quotes, '*', ',').
func plainHost(h string) bool {
	host, port := h, ""
	if i := strings.LastIndex(h, ":"); i >= 0 && !strings.HasSuffix(h, "]") {
		host, port = h[:i], h[i+1:]
		if port == "" || len(port) > 5 || strings.Trim(port, "0123456789") != "" {
			return false
		}
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return len(host) > 2 && strings.Trim(host[1:len(host)-1], "0123456789abcdefABCDEF:") == ""
	}
	if host == "" || strings.HasPrefix(host, ".") || strings.HasPrefix(host, "-") {
		return false
	}
	for _, c := range host {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-') {
			return false
		}
	}
	return true
}

// origins the web app's CSP must allow for the map (the styles' hosts; a style loads its tiles, fonts and icons from
// the same host, as OpenFreeMap's and VersaTiles' do).
func (m *mapConfig) origins() []string {
	if m == nil {
		return nil
	}
	seen := map[string]bool{}
	for _, s := range append(append([]string{}, m.Light...), m.Dark...) {
		if u, err := url.Parse(s); err == nil {
			seen["https://"+u.Host] = true
		}
	}
	out := make([]string, 0, len(seen))
	for o := range seen {
		out = append(out, o)
	}
	sort.Strings(out)
	return out
}

// buildCSP is the web app's Content-Security-Policy. connect-src: besides this server, Hugging Face, where the web
// app downloads the search text model (server/models.json) and whose CDN host under hf.co has changed over time, and
// the map's tile servers. img-src blob: and data: for the map's decoded images.
func buildCSP(mapOrigins []string) string {
	connect := "'self' https://huggingface.co https://*.hf.co"
	if len(mapOrigins) > 0 {
		connect += " " + strings.Join(mapOrigins, " ")
	}
	return "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
		"img-src 'self' blob: data:; media-src 'self' blob:; connect-src " + connect + "; worker-src 'self'; " +
		"manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
}
