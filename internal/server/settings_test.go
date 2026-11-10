package server_test

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// An effort or Ultracode picked in the menu is kept at once, without a
// turn: the session list says it, every device hears ("sessions"), a
// restart keeps it, "default" clears it, and anything but a level's name is
// refused.
func TestSettingsKeptAtOnce(t *testing.T) {
	root, work := t.TempDir(), t.TempDir()
	projects := filepath.Join(root, "projects")
	writeSession(t, filepath.Join(projects, "A", "a.jsonl"), cwdRow("a1", work, time.Now().Add(-time.Hour)))
	idx := &index.Index{Root: projects, Registry: filepath.Join(root, "sessions")}
	file := filepath.Join(root, "cfg", "settings.json")
	start := func() string {
		s := server.New(server.Config{Token: token, Index: idx, Assets: transcript.Dir(filepath.Join(root, "assets")), Settings: file})
		srv := httptest.NewServer(s.Handler())
		t.Cleanup(srv.Close)
		t.Cleanup(s.Close)
		return srv.URL
	}
	type sess struct {
		ID        string
		Effort    string
		Ultracode bool
		Chrome    bool
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

	base := start()
	id := get(base).ID
	st := openStream(t, base, "")
	pos := 0
	if code, out := post(t, base+"/api/sessions/"+id+"/settings", map[string]any{"effort": "low", "ultracode": true, "chrome": true}); code != 200 {
		t.Fatalf("pick: %d %s", code, out)
	}
	st.wait(t, &pos, "sessions event", func(e server.Ev) bool { return e.Type == "sessions" })
	if s := get(base); s.Effort != "low" || !s.Ultracode || !s.Chrome {
		t.Errorf("after the pick: %+v", s)
	}

	if s := get(start()); s.Effort != "low" || !s.Ultracode || !s.Chrome {
		t.Errorf("after a restart: %+v", s)
	}

	post(t, base+"/api/sessions/"+id+"/settings", map[string]any{"effort": "default", "ultracode": false, "chrome": false})
	if s := get(base); s.Effort != "" || s.Ultracode || s.Chrome {
		t.Errorf("after default: %+v", s)
	}

	for _, bad := range []string{"--model", "High", "x y"} {
		if code, _ := post(t, base+"/api/sessions/"+id+"/settings", map[string]any{"effort": bad}); code != 400 {
			t.Errorf("effort %q: %d, want 400", bad, code)
		}
	}
}
