package server_test

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// Seen is shared by every device: old sessions count as read from the
// first start, new activity makes a session unread, marking it read tells
// every device ("sessions") and survives a restart.
func TestSeen(t *testing.T) {
	root, work := t.TempDir(), t.TempDir()
	projects := filepath.Join(root, "projects")
	path := filepath.Join(projects, "A", "a.jsonl")
	writeSession(t, path, cwdRow("a1", work, time.Now().Add(-48*time.Hour)))
	idx := &index.Index{Root: projects, Registry: filepath.Join(root, "sessions")}
	file := filepath.Join(root, "cfg", "seen.json")
	start := func() string {
		s := server.New(server.Config{Token: token, Index: idx, Assets: transcript.Dir(filepath.Join(root, "assets")), Seen: file})
		srv := httptest.NewServer(s.Handler())
		t.Cleanup(srv.Close)
		t.Cleanup(s.Close)
		return srv.URL
	}
	type sess struct {
		ID            string
		Updated, Seen time.Time
	}
	get := func(base string) sess {
		t.Helper()
		var list []sess
		_, body := fetch(t, base+"/api/sessions", token)
		if json.Unmarshal(body, &list) != nil || len(list) != 1 {
			t.Fatalf("sessions: %s", body)
		}
		return list[0]
	}
	unread := func(s sess) bool { return s.Updated.After(s.Seen) }

	base := start()
	if s := get(base); unread(s) {
		t.Fatalf("a session from before the first start shows unread: %+v", s)
	}

	// New activity, from anywhere: unread.
	st := openStream(t, base, "")
	pos := 0
	fh, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	fh.WriteString(cwdRow("a2", work, time.Now().Add(time.Second)) + "\n")
	fh.Close()
	st.wait(t, &pos, "sessions", of("", "sessions"))
	s := get(base)
	if !unread(s) {
		t.Fatalf("new activity is not unread: %+v", s)
	}

	// Read on one device: every device hears of it, and it is read.
	if code, out := post(t, base+"/api/sessions/"+s.ID+"/seen", map[string]time.Time{"updated": s.Updated}); code != 200 {
		t.Fatalf("seen: %d %s", code, out)
	}
	st.wait(t, &pos, "sessions after seen", of("", "sessions"))
	if s := get(base); unread(s) {
		t.Fatalf("still unread after seen: %+v", s)
	}
	// And after a restart.
	if s := get(start()); unread(s) {
		t.Fatalf("seen lost on restart: %+v", s)
	}

	// An older time does not go back; a request without one is refused.
	if code, _ := post(t, base+"/api/sessions/"+s.ID+"/seen", map[string]time.Time{"updated": s.Updated.Add(-time.Hour)}); code != 200 {
		t.Errorf("older seen: %d", code)
	}
	if s := get(base); unread(s) {
		t.Errorf("an older seen made it unread again: %+v", s)
	}
	if code, _ := post(t, base+"/api/sessions/"+s.ID+"/seen", map[string]string{}); code != 400 {
		t.Errorf("seen without updated: %d, want 400", code)
	}
}
