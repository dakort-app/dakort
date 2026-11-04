package server_test

import (
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/server"
)

// A restart for a new build waits for the running turn: asked for mid-turn
// it comes only once the turn is over, and then the server takes no more
// turns. With nothing running it comes at once.
func TestRestartWhenIdle(t *testing.T) {
	restarted := make(chan struct{}, 1)
	_, base := realServerWith(t, server.Config{Restart: func() { restarted <- struct{}{} }})
	st := openStream(t, base, "")
	pos := 0
	id, _ := newTurn(t, base, map[string]any{"text": "Count from 1 to 150, one number per line, nothing else."})
	st.wait(t, &pos, "turn running", func(e server.Ev) bool { return e.Session == id && e.Type == "turn" && e.State == "running" })

	code, out := post(t, base+"/api/restart", nil)
	if code != 200 || !strings.Contains(string(out), `"running":1`) {
		t.Fatalf("restart mid-turn: %d %s", code, out)
	}
	st.wait(t, &pos, "turn done", turnDone(id))
	select {
	case <-restarted:
		t.Fatal("restarted before the turn was over")
	default:
	}
	select {
	case <-restarted:
	case <-time.After(30 * time.Second):
		t.Fatal("no restart within 30 s of the turn ending")
	}
	if code, out := post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": "after-restart", "text": "hi"}); code != 503 {
		t.Errorf("a send after the restart began: %d %s, want 503", code, out)
	}

	// Nothing running: at once.
	idle := make(chan struct{}, 1)
	_, base2 := realServerWith(t, server.Config{Restart: func() { idle <- struct{}{} }})
	if code, out := post(t, base2+"/api/restart", nil); code != 200 || !strings.Contains(string(out), `"running":0`) {
		t.Fatalf("restart when idle: %d %s", code, out)
	}
	select {
	case <-idle:
	case <-time.After(3 * time.Second):
		t.Fatal("no restart within 3 s with nothing running")
	}

	// Without a Restart hook the route is off.
	_, base3 := realServerWith(t, server.Config{})
	if code, _ := post(t, base3+"/api/restart", nil); code != 501 {
		t.Errorf("restart without a hook: %d, want 501", code)
	}
}
