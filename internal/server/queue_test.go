package server_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/testcwd"
)

// Messages sent while a turn runs wait on the server and go one per turn
// end, in order; one can be taken back, and a stop hands the rest back
// instead of sending them.
func TestRealQueue(t *testing.T) {
	t.Parallel()
	base := realServer(t)
	st := openStream(t, base, "")
	pos := 0
	st.wait(t, &pos, "snapshot", func(e server.Ev) bool { return e.Type == "snapshot" })

	id, _ := newTurn(t, base, map[string]any{"text": "Reply with exactly one word: kiwi"})
	queue := func(text string) (string, int, []byte) {
		pid := testcwd.UUID()
		code, out := post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": pid, "text": text, "queue": true})
		return pid, code, out
	}
	var rep struct{ Queued, Duplicate bool }
	lime, code, out := queue("Reply with exactly one word: lime")
	if code != 202 || json.Unmarshal(out, &rep) != nil || !rep.Queued {
		t.Fatalf("queue while running: %d %s", code, out)
	}
	if code, out = post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": lime, "text": "Reply with exactly one word: lime", "queue": true}); code != 200 || json.Unmarshal(out, &rep) != nil || !rep.Duplicate {
		t.Errorf("a repeated queued send: %d %s", code, out)
	}
	queue("Reply with exactly one word: plum")
	q := st.wait(t, &pos, "queue of two", func(e server.Ev) bool { return e.Session == id && e.Type == "queue" && len(e.Queue) == 2 })
	if q.ev.Queue[0].PromptID != lime {
		t.Errorf("queue order: %+v", q.ev.Queue)
	}

	for _, want := range []string{"kiwi", "lime", "plum"} {
		done := st.wait(t, &pos, want+" done", turnDone(id))
		if r := done.ev.Result; r == nil || !r.OK || oneWord(r.Text) != want {
			t.Fatalf("turn %s: %+v %s", want, r, done.ev.Error)
		}
	}

	// Taken back: the text comes back, once.
	if code, out := post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(), "text": "Reply with exactly one word: fig"}); code != 202 {
		t.Fatalf("send: %d %s", code, out)
	}
	grape, _, _ := queue("Reply with exactly one word: grape")
	var back struct{ Text string }
	if code, out := post(t, base+"/api/sessions/"+id+"/unqueue/"+grape, map[string]any{}); code != 200 || json.Unmarshal(out, &back) != nil || back.Text != "Reply with exactly one word: grape" {
		t.Errorf("unqueue: %d %s", code, out)
	}
	if code, _ := post(t, base+"/api/sessions/"+id+"/unqueue/"+grape, map[string]any{}); code != 404 {
		t.Errorf("a second unqueue: %d, want 404", code)
	}

	// A stop hands the queue back and nothing more runs.
	queue("Reply with exactly one word: melon")
	var stopped struct{ Queued []struct{ Text string } }
	if code, out := post(t, base+"/api/sessions/"+id+"/interrupt", map[string]any{}); code != 200 || json.Unmarshal(out, &stopped) != nil ||
		len(stopped.Queued) != 1 || stopped.Queued[0].Text != "Reply with exactly one word: melon" {
		t.Errorf("interrupt: %d %s", code, out)
	}
	st.wait(t, &pos, "fig done", turnDone(id))
	time.Sleep(3 * time.Second)
	for _, e := range st.all()[pos:] {
		if e.ev.Session == id && e.ev.Type == "turn" {
			t.Errorf("a turn after the stop: %+v", e.ev)
		}
	}
}
