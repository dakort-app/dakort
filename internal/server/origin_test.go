package server_test

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// A POST from another page (another site, or the same host at another
// port) is refused even with the cookie; the app's own pages and programs
// that send no browser headers get through. On plain HTTP a browser sends
// no Sec-Fetch-Site, so Origin decides there.
func TestCrossSiteRefused(t *testing.T) {
	root := t.TempDir()
	s := server.New(server.Config{Token: token, Assets: transcript.Dir(filepath.Join(root, "assets")),
		Index: &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")}})
	t.Cleanup(s.Close)
	h := s.Handler()
	post := func(headers ...string) int {
		req := httptest.NewRequest("POST", "http://laptop.example.ts.net:3002/api/folders/close", strings.NewReader(`{"path":"C:/nowhere"}`))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "made_token", Value: token})
		for i := 0; i+1 < len(headers); i += 2 {
			req.Header.Set(headers[i], headers[i+1])
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	for _, c := range []struct {
		name    string
		headers []string
		refused bool
	}{
		{"a program, no browser headers", nil, false},
		{"the app's own page over HTTPS", []string{"Sec-Fetch-Site", "same-origin"}, false},
		{"the app's own page over plain HTTP", []string{"Origin", "http://laptop.example.ts.net:3002"}, false},
		{"another site over HTTPS", []string{"Sec-Fetch-Site", "cross-site", "Origin", "https://evil.example"}, true},
		{"the same host at another port", []string{"Sec-Fetch-Site", "same-site", "Origin", "http://laptop.example.ts.net:3001"}, true},
		{"another site over plain HTTP", []string{"Origin", "http://evil.example"}, true},
		{"the same host at another port over plain HTTP", []string{"Origin", "http://laptop.example.ts.net:3001"}, true},
	} {
		code := post(c.headers...)
		if c.refused && code != http.StatusForbidden {
			t.Errorf("%s: %d, want 403", c.name, code)
		}
		if !c.refused && code == http.StatusForbidden {
			t.Errorf("%s: refused, want let through", c.name)
		}
	}
}

// The Tailscale login is gone (2026-10-29): the header Serve adds no
// longer logs anyone in, from loopback or elsewhere, and plain HTTP
// through Serve is no longer redirected.
func TestTailscaleHeaderIsNotALogin(t *testing.T) {
	root := t.TempDir()
	s := server.New(server.Config{Token: token, Assets: transcript.Dir(filepath.Join(root, "assets")),
		Index: &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")}})
	t.Cleanup(s.Close)
	req := httptest.NewRequest("GET", "/api/sessions", nil)
	req.RemoteAddr = "127.0.0.1:50000"
	req.Header.Set("Tailscale-User-Login", "alex@example.com")
	req.Header.Set("X-Forwarded-Host", "laptop")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("through Serve with the login header: %d, want 401", rec.Code)
	}
}
