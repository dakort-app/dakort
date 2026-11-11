package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/dakort-app/dakort/internal/claude"
	"github.com/dakort-app/dakort/internal/codex"
	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
)

// A sign-in started from the page gets the CLI's link (and Codex's
// one-time code) without a terminal, against throwaway config folders so
// the real login on this machine is never touched; cancelled before any
// account is involved.
func TestSignInShowsTheLink(t *testing.T) {
	claudeBin, errC := claude.FindBinary()
	codexBin, errX := codex.FindBinary()
	if errC != nil && errX != nil {
		t.Skip("no CLI installed")
	}
	root := t.TempDir()
	s := server.New(server.Config{Token: token, ClaudeBin: claudeBin, CodexBin: codexBin,
		CLIEnv: []string{"CLAUDE_CONFIG_DIR=" + filepath.Join(root, "claude"), "CODEX_HOME=" + root, "ANTHROPIC_API_KEY=", "OPENAI_API_KEY="},
		Index:  &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")}})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)

	post := func(path string, body string) map[string]any {
		t.Helper()
		req, _ := http.NewRequest("POST", srv.URL+path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return map[string]any{"status": resp.StatusCode}
		}
		var out map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		return out
	}

	if errC == nil {
		st := post("/api/signin", `{"cli":"claude"}`)
		url, _ := st["url"].(string)
		if st["state"] != "waiting" || !strings.HasPrefix(url, "https://") || st["pasteCode"] != true {
			t.Errorf("claude: %v", st)
		}
		// Asked again while it runs, the same run answers.
		if again := post("/api/signin", `{"cli":"claude"}`); again["url"] != url {
			t.Errorf("a second start made a new run: %v", again)
		}
		post("/api/signin/cancel", `{"cli":"claude"}`)
	}
	if errX == nil {
		st := post("/api/signin", `{"cli":"codex"}`)
		url, _ := st["url"].(string)
		code, _ := st["code"].(string)
		if st["state"] != "waiting" || !strings.Contains(url, "auth.openai.com") || !regexp.MustCompile(`^[A-Z0-9]+-[A-Z0-9]+$`).MatchString(code) || st["pasteCode"] == true {
			t.Errorf("codex: %v", st)
		}
		post("/api/signin/cancel", `{"cli":"codex"}`)
	}
	if st := post("/api/signin", `{"cli":"other"}`); st["status"] != 400 {
		t.Errorf("unknown cli: %v", st)
	}
}
