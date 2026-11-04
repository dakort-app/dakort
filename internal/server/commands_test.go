package server_test

import (
	"encoding/json"
	"net/url"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/testcwd"
)

// The "/" menu, from the real CLI: the headless built-ins first, in order,
// none of the terminal-only ones, and the folder must exist.
func TestCommands(t *testing.T) {
	_, base := realServerWith(t, server.Config{})
	cwd := testcwd.New(t)
	resp, body := fetch(t, base+"/api/commands?folder="+url.QueryEscape(cwd), token)
	var list []struct {
		Name    string
		Builtin bool
	}
	if resp.StatusCode != 200 || json.Unmarshal(body, &list) != nil {
		t.Fatalf("commands: %d %s", resp.StatusCode, body)
	}
	var builtins []string
	for _, c := range list {
		if c.Builtin {
			builtins = append(builtins, c.Name)
		}
		switch c.Name {
		case "model", "config", "clear", "mcp", "color", "heapdump":
			t.Errorf("terminal-only command offered: %s", c.Name)
		}
	}
	want := []string{"compact", "context", "usage", "goal", "recap", "rename", "init"}
	if len(builtins) != len(want) {
		t.Fatalf("built-ins %v, want %v", builtins, want)
	}
	for i := range want {
		if builtins[i] != want[i] {
			t.Fatalf("built-ins %v, want %v", builtins, want)
		}
	}
	t.Logf("%d commands, %d of them skills or custom", len(list), len(list)-len(builtins))

	if resp, _ := fetch(t, base+"/api/commands?folder=relative", token); resp.StatusCode != 400 {
		t.Errorf("a relative folder: %d, want 400", resp.StatusCode)
	}
}

// Renaming runs /rename through the CLI as a quiet turn; the list then
// shows the new name.
func TestRename(t *testing.T) {
	_, base := realServerWith(t, server.Config{})
	st := openStream(t, base, "")
	pos := 0
	id, _ := newTurn(t, base, map[string]any{"text": "Reply with one word: hi"})
	st.wait(t, &pos, "first turn done", turnDone(id))
	if code, out := post(t, base+"/api/sessions/"+id+"/rename", map[string]string{"title": "  My   renamed session "}); code != 202 {
		t.Fatalf("rename: %d %s", code, out)
	}
	done := st.wait(t, &pos, "rename done", turnDone(id))
	if !done.ev.Idle {
		t.Errorf("the rename turn is not marked quiet: %+v", done.ev)
	}
	// The list refreshes once the process has exited, just after "done".
	title := ""
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline) && title != "My renamed session"; time.Sleep(500 * time.Millisecond) {
		var list []struct{ ID, Title string }
		_, body := fetch(t, base+"/api/sessions", token)
		json.Unmarshal(body, &list)
		for _, s := range list {
			if s.ID == id {
				title = s.Title
			}
		}
	}
	if title != "My renamed session" {
		t.Errorf("title %q, want %q", title, "My renamed session")
	}
	if code, _ := post(t, base+"/api/sessions/"+id+"/rename", map[string]string{"title": "  "}); code != 400 {
		t.Errorf("an empty name: %d, want 400", code)
	}
}
