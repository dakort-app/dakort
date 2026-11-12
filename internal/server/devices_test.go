package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// postLoggedIn sends JSON with the login cookie, optionally as if through
// Tailscale Serve (from another device), and returns the status and body.
func postLoggedIn(t *testing.T, url string, body any, viaServe bool) (int, string) {
	t.Helper()
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
	if viaServe {
		req.Header.Set("X-Forwarded-For", "100.101.102.103")
		req.Header.Set("Tailscale-User-Login", "someone@example.com")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

func getLoggedIn(t *testing.T, url string, viaServe bool) (int, string, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
	if viaServe {
		req.Header.Set("X-Forwarded-For", "100.101.102.103")
		req.Header.Set("Tailscale-User-Login", "someone@example.com")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out), resp.Header.Get("Content-Type")
}

// The Other devices panel: the addresses and Tailscale's state as the
// program reports them, the password chosen and changed from the computer
// itself only, and a QR code for a current address and nothing else.
func TestDevices(t *testing.T) {
	root := t.TempDir()
	devices := server.Devices{Tailscale: "up", LocalURL: "http://127.0.0.1:3002/", Addrs: []server.DeviceAddr{
		{URL: "https://laptop.example.ts.net/", Kind: "https"},
		{URL: "http://laptop.example.ts.net:3002/", Kind: "tailnet"},
	}}
	s := server.New(server.Config{Token: token, Password: filepath.Join(root, "cfg", "password.json"), Assets: transcript.Dir(filepath.Join(root, "assets")),
		Index:   &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")},
		Devices: func() server.Devices { return devices }})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)
	u := srv.URL

	var st struct {
		Tailscale   string `json:"tailscale"`
		Addrs       []struct{ URL, Kind string }
		LocalURL    string `json:"localUrl"`
		PasswordSet bool   `json:"passwordSet"`
		Local       bool   `json:"local"`
	}
	read := func(viaServe bool) {
		t.Helper()
		code, body, _ := getLoggedIn(t, u+"/api/devices", viaServe)
		if code != 200 {
			t.Fatalf("GET /api/devices: %d %s", code, body)
		}
		if err := json.Unmarshal([]byte(body), &st); err != nil {
			t.Fatal(err)
		}
	}
	read(false)
	if st.PasswordSet || !st.Local || st.Tailscale != "up" || len(st.Addrs) != 2 || st.Addrs[0].Kind != "https" || st.LocalURL != "http://127.0.0.1:3002/" {
		t.Errorf("on the computer, before a password: %+v", st)
	}
	read(true)
	if st.Local {
		t.Error("a request through Serve counts as the computer itself")
	}

	// The password: not without the cookie, not short, then set, then
	// changed from a logged-in device elsewhere without the old one; the
	// login takes the new one only.
	if code, body, _ := postAs(t, u+"/api/password", map[string]string{"password": "correct horse"}, false); code != 401 {
		t.Errorf("password without being logged in: %d %s, want 401", code, body)
	}
	if code, _ := postLoggedIn(t, u+"/api/password", map[string]string{"password": "short"}, false); code != 400 {
		t.Errorf("short password: %d, want 400", code)
	}
	if code, body := postLoggedIn(t, u+"/api/password", map[string]string{"password": "correct horse"}, false); code != 200 {
		t.Fatalf("choosing the password: %d %s", code, body)
	}
	read(false)
	if !st.PasswordSet {
		t.Error("the panel does not see the password")
	}
	if code, body := postLoggedIn(t, u+"/api/password", map[string]string{"password": "battery staple"}, true); code != 200 {
		t.Fatalf("changing the password from a logged-in device elsewhere: %d %s", code, body)
	}
	if code, _, _ := postAs(t, u+"/api/login", map[string]string{"password": "correct horse"}, true); code != 401 {
		t.Errorf("the old password still logs in: %d", code)
	}
	if code, _, c := postAs(t, u+"/api/login", map[string]string{"password": "battery staple"}, true); code != 200 || c == nil {
		t.Errorf("the new password: %d cookie=%v", code, c)
	}

	// The QR code: SVG for a current address, nothing for any other text.
	code, body, ct := getLoggedIn(t, u+"/api/devices/qr?url=https://laptop.example.ts.net/", false)
	if code != 200 || ct != "image/svg+xml" || !strings.HasPrefix(body, "<svg") || !strings.Contains(body, "<path") {
		t.Errorf("QR: %d %s %.60s", code, ct, body)
	}
	if code, _, _ := getLoggedIn(t, u+"/api/devices/qr?url=https://example.com/", false); code != 404 {
		t.Errorf("QR of a foreign address: %d, want 404", code)
	}

	// Before any password, a device that arrives is told where to choose one.
	devices.Addrs = nil
	s2 := server.New(server.Config{Token: token, Password: filepath.Join(root, "cfg2", "password.json"), Assets: transcript.Dir(filepath.Join(root, "assets2")),
		Index: &index.Index{Root: filepath.Join(root, "projects2"), Registry: filepath.Join(root, "sessions2")}})
	srv2 := httptest.NewServer(s2.Handler())
	t.Cleanup(srv2.Close)
	t.Cleanup(s2.Close)
	req, _ := http.NewRequest("GET", srv2.URL+"/", nil)
	req.Header.Set("X-Forwarded-For", "100.101.102.103")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 401 || !strings.Contains(string(page), "tap the devices icon") {
		t.Errorf("a device before any password: %d, says %v", resp.StatusCode, strings.Contains(string(page), "devices icon"))
	}
	// With nothing known about addresses the panel still answers.
	code, body, _ = getLoggedIn(t, srv2.URL+"/api/devices", false)
	if code != 200 || !strings.Contains(body, `"tailscale":"none"`) || !strings.Contains(body, `"addrs":[]`) {
		t.Errorf("panel with nothing known: %d %s", code, body)
	}
}
