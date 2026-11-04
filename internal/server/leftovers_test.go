package server_test

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/procs"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/testcwd"
)

// A process a turn leaves running is listed for the session once the
// turn ends, with its program and folder; it keeps the folder from being
// renamed, and the refusal names it; Stop ends it, the list empties, and
// the rename goes through.
func TestRealLeftovers(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("processes are tracked on Windows only")
	}
	t.Parallel()
	base := realServer(t)
	st := openStream(t, base, "")
	pos := 0
	st.wait(t, &pos, "snapshot", func(e server.Ev) bool { return e.Type == "snapshot" })

	id, cwd := newTurn(t, base, map[string]any{"permissionMode": "bypassPermissions",
		"text": "Use the Bash tool to run exactly this command, then reply with the word done: nohup sleep 120 >/dev/null 2>&1 &"})
	if done := st.wait(t, &pos, "done", turnDone(id)); done.ev.Result == nil || !done.ev.Result.OK {
		t.Fatalf("turn: %+v", done.ev)
	}
	left := st.wait(t, &pos, "leftovers", func(e server.Ev) bool { return e.Session == id && e.Type == "leftovers" && len(e.Leftovers) > 0 })
	var sleep procs.Info
	for _, in := range left.ev.Leftovers {
		if strings.EqualFold(in.Name, "sleep.exe") {
			sleep = in
		}
	}
	if sleep.PID == 0 {
		t.Fatalf("sleep not listed: %+v", left.ev.Leftovers)
	}
	t.Cleanup(func() {
		post(t, base+fmt.Sprintf("/api/sessions/%s/leftovers/%d/stop", id, sleep.PID), map[string]any{})
	})
	if got, _ := filepath.EvalSymlinks(sleep.Dir); !strings.EqualFold(got, cwd) {
		t.Errorf("sleep's folder %q, want %q", sleep.Dir, cwd)
	}
	if time.Since(sleep.Started) > time.Minute {
		t.Errorf("started %v", sleep.Started)
	}

	moved := cwd + "-renamed"
	testcwd.Also(t, moved)
	code, out := post(t, base+"/api/folders/rename", map[string]any{"path": cwd, "name": filepath.Base(moved)})
	var refused struct {
		Error     string
		Leftovers []struct {
			PID     int
			Name    string
			Session string
		}
	}
	if code != 409 || json.Unmarshal(out, &refused) != nil || len(refused.Leftovers) != 1 || refused.Leftovers[0].PID != sleep.PID || refused.Leftovers[0].Session != id {
		t.Fatalf("rename with a leftover in the folder: %d %s", code, out)
	}

	if code, out := post(t, base+fmt.Sprintf("/api/sessions/%s/leftovers/%d/stop", id, sleep.PID), map[string]any{}); code != 200 {
		t.Fatalf("stop: %d %s", code, out)
	}
	st.wait(t, &pos, "leftovers gone", func(e server.Ev) bool { return e.Session == id && e.Type == "leftovers" && len(e.Leftovers) == 0 })
	if code, out := post(t, base+fmt.Sprintf("/api/sessions/%s/leftovers/%d/stop", id, sleep.PID), map[string]any{}); code != 404 {
		t.Errorf("a second stop: %d %s, want 404", code, out)
	}
	if code, out := post(t, base+"/api/folders/rename", map[string]any{"path": cwd, "name": filepath.Base(moved)}); code != 200 {
		t.Fatalf("rename after the stop: %d %s", code, out)
	}
}
