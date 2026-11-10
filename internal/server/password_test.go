package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// postAs sends JSON with no cookie, optionally as if through Tailscale
// Serve, and returns the status, body and any cookie set.
func postAs(t *testing.T, url string, body any, viaServe bool) (int, string, *http.Cookie) {
	t.Helper()
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
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
	var c *http.Cookie
	for _, k := range resp.Cookies() {
		if k.Name == "dakort_token" {
			c = k
		}
	}
	return resp.StatusCode, string(out), c
}

func TestPassword(t *testing.T) {
	root := t.TempDir()
	pwFile := filepath.Join(root, "cfg", "password.json")
	s := server.New(server.Config{Token: token, Password: pwFile, Assets: transcript.Dir(filepath.Join(root, "assets")),
		Index: &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")}})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)
	u := srv.URL

	// Before a password exists, a page request gets the page in setup mode
	// on the laptop, and a note through Serve.
	if resp, body := fetch(t, u+"/", ""); resp.StatusCode != 401 || !strings.Contains(string(body), `data-mode="setup"`) {
		t.Errorf("first visit on the laptop: %d, setup mode=%v", resp.StatusCode, strings.Contains(string(body), "setup"))
	}
	if code, body, _ := postAs(t, u+"/api/setup", map[string]string{"password": "correct horse"}, true); code != 403 {
		t.Errorf("setup through Serve: %d %s, want 403", code, body)
	}
	if code, _, _ := postAs(t, u+"/api/setup", map[string]string{"password": "short"}, false); code != 400 {
		t.Errorf("short password: %d, want 400", code)
	}
	code, body, c := postAs(t, u+"/api/setup", map[string]string{"password": "correct horse"}, false)
	if code != 200 || c == nil || c.Value != token {
		t.Fatalf("setup on the laptop: %d %s cookie=%v", code, body, c)
	}
	if code, _, _ := postAs(t, u+"/api/setup", map[string]string{"password": "another one"}, false); code != 409 {
		t.Errorf("second setup: %d, want 409", code)
	}
	if data, _ := os.ReadFile(pwFile); bytes.Contains(data, []byte("correct horse")) {
		t.Error("the password is stored as text")
	}

	// Logging in through Serve, the way the phone does.
	if code, body, c := postAs(t, u+"/api/login", map[string]string{"password": "correct horse"}, true); code != 200 || c == nil || c.Value != token {
		t.Errorf("login: %d %s cookie=%v", code, body, c)
	}

	// Wrong guesses cost a second each and close the login after five.
	start := time.Now()
	for i := 0; i < 5; i++ {
		if code, _, c := postAs(t, u+"/api/login", map[string]string{"password": "wrong"}, true); code != 401 || c != nil {
			t.Fatalf("wrong password %d: %d cookie=%v", i, code, c)
		}
	}
	if took := time.Since(start); took < 4*time.Second {
		t.Errorf("five wrong guesses took %v; each should cost about a second", took)
	}
	if code, _, c := postAs(t, u+"/api/login", map[string]string{"password": "correct horse"}, true); code != 429 || c != nil {
		t.Errorf("right password while locked: %d cookie=%v, want 429", code, c)
	}
}
