package server_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// Idle compaction against the real CLI, with a 30 s "cache" and a 25 s
// lead, so a session is due 5 s after its last reply. Switched off it is
// left alone; switched on (and its folder open) it is compacted once, as a
// turn marked idle, with the last reply's model.
func TestIdleCompaction(t *testing.T) {
	_, base := realServerWith(t, server.Config{Compact: server.CompactConfig{
		On: true, Above: 1, TTL: 30 * time.Second, Lead: 25 * time.Second, Every: 500 * time.Millisecond,
	}})
	st := openStream(t, base, "")
	pos := 0
	id, cwd := newTurn(t, base, map[string]any{"text": "Remember the word heron. Reply with just: ok"})
	st.wait(t, &pos, "first turn done", turnDone(id))

	// Off, folder open: past the 5 s mark, nothing.
	if code, out := post(t, base+"/api/sessions/"+id+"/settings", map[string]any{"idleCompact": false}); code != 200 {
		t.Fatalf("switch off: %d %s", code, out)
	}
	if code, out := post(t, base+"/api/folders/open", map[string]string{"path": cwd}); code != 200 {
		t.Fatalf("open folder: %d %s", code, out)
	}
	time.Sleep(8 * time.Second)
	for _, e := range st.all()[pos:] {
		if e.ev.Session == id && e.ev.Type == "turn" {
			t.Fatalf("a turn while switched off: %+v", e.ev)
		}
	}
	var list []struct {
		ID          string
		IdleCompact bool
	}
	_, body := fetch(t, base+"/api/sessions", token)
	json.Unmarshal(body, &list)
	for _, s := range list {
		if s.ID == id && s.IdleCompact {
			t.Errorf("the list says idle compaction is on after switching it off")
		}
	}

	// On: compacted at once, as an idle turn.
	post(t, base+"/api/sessions/"+id+"/settings", map[string]any{"idleCompact": true})
	start := st.wait(t, &pos, "idle compaction starting", func(e server.Ev) bool { return e.Session == id && e.Type == "turn" && e.State == "starting" })
	if !start.ev.Idle {
		t.Errorf("the compaction turn is not marked idle: %+v", start.ev)
	}
	done := st.wait(t, &pos, "idle compaction done", turnDone(id))
	if !done.ev.Idle || done.ev.Result == nil || !done.ev.Result.OK {
		t.Fatalf("compaction turn: %+v (result %+v)", done.ev, done.ev.Result)
	}

	// The transcript has the boundary; log what came with it, for the UI.
	var page struct{ Rows []transcript.Row }
	_, body = fetch(t, base+"/api/sessions/"+id+"/rows?n=50", token)
	json.Unmarshal(body, &page)
	boundary := -1
	for i, r := range page.Rows {
		if r.Subtype == "compact_boundary" {
			boundary = i
		}
	}
	if boundary < 0 {
		t.Fatalf("no compact_boundary row among %d", len(page.Rows))
	}
	b := page.Rows[boundary]
	t.Logf("boundary: pre %d, post %d tokens", b.PreTokens, b.PostTokens)
	if b.PreTokens == 0 {
		t.Errorf("the boundary has no preTokens: %+v", b)
	}
	for _, r := range page.Rows[max(boundary-2, 0):] {
		text := r.PromptText()
		if len(text) > 80 {
			text = text[:80] + "…"
		}
		t.Logf("row %s %s meta=%v summary=%v model=%s context=%d text=%q", r.Role, r.Subtype, r.Meta, r.CompactSummary, r.Model, r.Context, text)
	}

	// Once: no second compaction while the window is still open.
	time.Sleep(4 * time.Second)
	for _, e := range st.all()[pos:] {
		if e.ev.Session == id && e.ev.Type == "turn" {
			t.Errorf("a second turn after the compaction: %+v", e.ev)
		}
	}
}
