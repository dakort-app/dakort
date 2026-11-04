package server_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/codex"
	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/testcwd"
	"github.com/dakort-app/dakort/internal/transcript"
)

// A Codex session through the server: a new thread, the stream's echo and
// deltas, the rows, a second turn, an approval, a rename and a delete. The
// rollout Codex writes lives under ~/.codex/sessions; the delete moves it
// into the test's trash, and a failure before that removes it by hand
// after checking it is the test's own.
func TestRealCodex(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("real CLI test")
	}
	if _, err := codex.FindBinary(); err != nil {
		t.Skip(err)
	}
	trash := t.TempDir()
	_, base := realServerWith(t, server.Config{Trash: trash})
	st := openStream(t, base, "")
	pos := 0
	st.wait(t, &pos, "snapshot", func(e server.Ev) bool { return e.Type == "snapshot" })

	cwd := testcwd.New(t)
	first := map[string]any{"promptId": testcwd.UUID(), "cwd": cwd, "provider": "codex", "model": "gpt-5.6-sol", "effort": "low",
		"permissionMode": "plan", "text": "Reply with exactly one word: kiwi"}
	t0 := time.Now()
	code, body := post(t, base+"/api/sessions", first)
	var rep struct {
		Session string `json:"session"`
	}
	if code != 202 || json.Unmarshal(body, &rep) != nil || rep.Session == "" {
		t.Fatalf("new session: %d %s", code, body)
	}
	id := rep.Session
	t.Logf("ack after %v, thread %s", time.Since(t0), id)
	t.Cleanup(func() { removeTestRollout(t, id) })

	st.wait(t, &pos, "running", func(e server.Ev) bool { return e.Session == id && e.Type == "turn" && e.State == "running" })
	echo := st.wait(t, &pos, "prompt echo", func(e server.Ev) bool { return e.Session == id && e.Type == "appended" && e.PromptID != "" })
	st.wait(t, &pos, "text delta", func(e server.Ev) bool { return e.Session == id && e.Type == "delta" && e.Kind == "text" })
	done := st.wait(t, &pos, "done", turnDone(id))
	if r := done.ev.Result; r == nil || !r.OK || oneWord(r.Text) != "kiwi" || r.Usage == nil {
		t.Fatalf("first turn: %+v %s", r, done.ev.Error)
	}
	t.Logf("first turn done %v after the send", time.Since(t0))

	// Listed as a Codex session, in the test folder.
	sess := sessionByID(t, base, id)
	if sess.Provider != "codex" || sess.Cwd != cwd || sess.Used.Model != "gpt-5.6-sol" || sess.Used.Mode != "plan" {
		t.Errorf("session: %+v", sess)
	}

	var page struct {
		Rows []transcript.Row `json:"rows"`
	}
	resp, body := fetch(t, base+"/api/sessions/"+id+"/rows", token)
	if resp.StatusCode != 200 || json.Unmarshal(body, &page) != nil {
		t.Fatalf("rows: %d %s", resp.StatusCode, body)
	}
	var prompt, reply bool
	for _, r := range page.Rows {
		if r.PromptText() == first["text"] {
			prompt = true
			if r.UUID != echo.ev.UUID {
				t.Errorf("prompt row %s, echo said %s", r.UUID, echo.ev.UUID)
			}
		}
		if r.Role == transcript.Assistant && len(r.Blocks) > 0 && oneWord(r.Blocks[0].Text) == "kiwi" {
			reply = true
		}
	}
	if !prompt || !reply {
		t.Errorf("rows lack the prompt (%v) or the reply (%v): %+v", prompt, reply, page.Rows)
	}

	// A second turn resumes the thread; the read-only sandbox makes the
	// file write ask first.
	code, body = post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(),
		"text": "Create a file named lime.txt containing the word lime in the current folder, now, without asking. Then reply with one word: done"})
	if code != 202 {
		t.Fatalf("second send: %d %s", code, body)
	}
	ask := st.wait(t, &pos, "approval", of(id, "permission"))
	if p := ask.ev.Permission; p == nil || p.Tool == "" || p.Input == nil {
		t.Fatalf("permission: %+v", ask.ev)
	}
	if code, body = post(t, base+"/api/sessions/"+id+"/permissions/"+ask.ev.Permission.ID, map[string]any{"allow": true}); code != 200 {
		t.Fatalf("allow: %d %s", code, body)
	}
	st.wait(t, &pos, "permission done", func(e server.Ev) bool { return e.Session == id && e.Type == "permissionDone" })
	// Codex may ask again (to check its work); allow whatever comes until the turn ends.
	for {
		e := st.wait(t, &pos, "approval or done", func(e server.Ev) bool {
			return e.Session == id && (e.Type == "permission" || e.Type == "turn" && e.State == "done")
		})
		if e.ev.Type == "permission" {
			post(t, base+"/api/sessions/"+id+"/permissions/"+e.ev.Permission.ID, map[string]any{"allow": true})
			continue
		}
		if r := e.ev.Result; r == nil || !r.OK {
			t.Fatalf("second turn: %+v %s", r, e.ev.Error)
		}
		break
	}
	if data, err := os.ReadFile(filepath.Join(cwd, "lime.txt")); err != nil || !strings.Contains(string(data), "lime") {
		t.Errorf("lime.txt: %q %v", data, err)
	}

	// Rename: Codex keeps the name in its index; the list picks it up.
	if code, body = post(t, base+"/api/sessions/"+id+"/rename", map[string]any{"title": "Kiwi and lime"}); code != 200 {
		t.Fatalf("rename: %d %s", code, body)
	}
	deadline := time.Now().Add(15 * time.Second)
	for sessionByID(t, base, id).Title != "Kiwi and lime" {
		if time.Now().After(deadline) {
			t.Errorf("renamed, but the list still says %q", sessionByID(t, base, id).Title)
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Delete moves the rollout to the trash; restore brings it back.
	code, body = post(t, base+"/api/sessions/"+id+"/delete", map[string]any{})
	var tr struct {
		Trash string `json:"trash"`
	}
	if code != 200 || json.Unmarshal(body, &tr) != nil {
		t.Fatalf("delete: %d %s", code, body)
	}
	if _, ok := findSession(t, base, id); ok {
		t.Error("deleted, but still listed")
	}
	if code, body = post(t, base+"/api/trash/"+tr.Trash+"/restore", map[string]any{}); code != 200 {
		t.Fatalf("restore: %d %s", code, body)
	}
	if _, ok := findSession(t, base, id); !ok {
		t.Error("restored, but not listed")
	}
	if code, body = post(t, base+"/api/sessions/"+id+"/delete", map[string]any{}); code != 200 {
		t.Fatalf("second delete: %d %s", code, body)
	}
}

func findSession(t *testing.T, base, id string) (index.Session, bool) {
	t.Helper()
	resp, body := fetch(t, base+"/api/sessions", token)
	var list []index.Session
	if resp.StatusCode != 200 || json.Unmarshal(body, &list) != nil {
		t.Fatalf("sessions: %d %s", resp.StatusCode, body)
	}
	for _, s := range list {
		if s.ID == id {
			return s, true
		}
	}
	return index.Session{}, false
}

func sessionByID(t *testing.T, base, id string) index.Session {
	t.Helper()
	s, ok := findSession(t, base, id)
	if !ok {
		t.Fatalf("session %s not listed", id)
	}
	return s
}

// removeTestRollout removes a rollout left under ~/.codex/sessions, after
// checking its first line names a test folder.
func removeTestRollout(t *testing.T, id string) {
	t.Helper()
	paths, _ := filepath.Glob(filepath.Join(transcript.CodexSessionsRoot(), "*", "*", "*", "rollout-*-"+id+".jsonl"))
	for _, p := range paths {
		head := make([]byte, 4096)
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		n, _ := f.Read(head)
		f.Close()
		if !bytes.Contains(head[:n], []byte(testcwd.Marker)) {
			t.Errorf("refusing to remove %s: not a test rollout", p)
			continue
		}
		if err := os.Remove(p); err != nil {
			t.Errorf("rollout left behind: %v", err)
		}
	}
}
