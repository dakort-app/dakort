package server_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
)

// The snapshot a page gets on connecting names the server's build, so a
// page from an older one knows to reload.
func TestSnapshotNamesBuild(t *testing.T) {
	root := t.TempDir()
	s := server.New(server.Config{Token: token, Version: "v9.9.9-test",
		Index: &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")}})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/events", nil)
	req.AddCookie(&http.Cookie{Name: "made_token", Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if !strings.Contains(line, `"snapshot"`) {
			continue
		}
		if !strings.Contains(line, `"build":"v9.9.9-test"`) {
			t.Fatalf("snapshot without the build: %s", line)
		}
		return
	}
	t.Fatal("no snapshot within 5 s")
}
