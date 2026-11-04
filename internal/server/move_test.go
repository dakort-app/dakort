package server_test

import (
	"encoding/json"
	"net/http/httptest"
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

func projName(cwd string) string { return filepath.Base(transcript.ProjectDir(cwd)) }

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// A renamed folder keeps its sessions, its subfolders' and its memory,
// across a restart; a sibling whose name starts the same stays put, and a
// new folder given the old name later starts empty.
func TestMoveFolder(t *testing.T) {
	root, work := t.TempDir(), t.TempDir()
	projects := filepath.Join(root, "projects")
	old := filepath.Join(work, "proj a.v1")
	sub := filepath.Join(old, "sub")
	sibling := old + "-x"
	for _, d := range []string{sub, sibling} {
		os.MkdirAll(d, 0o755)
	}
	before := time.Now().Add(-time.Hour)
	writeSession(t, filepath.Join(projects, projName(old), "a.jsonl"), cwdRow("a1", old, before))
	writeSession(t, filepath.Join(projects, projName(old), "memory", "MEMORY.md"), "remember")
	writeSession(t, filepath.Join(projects, projName(sub), "b.jsonl"), cwdRow("b1", sub, before))
	writeSession(t, filepath.Join(projects, projName(sibling), "c.jsonl"), cwdRow("c1", sibling, before))
	moves := filepath.Join(root, "moves.json")
	start := func() string {
		idx := &index.Index{Root: projects, Registry: filepath.Join(root, "sessions")}
		s := server.New(server.Config{Token: token, Index: idx, Moves: moves, Folders: filepath.Join(root, "folders.json")})
		srv := httptest.NewServer(s.Handler())
		t.Cleanup(srv.Close)
		t.Cleanup(s.Close)
		return srv.URL
	}
	base := start()
	if code, out := post(t, base+"/api/folders/open", map[string]any{"path": old}); code != 200 {
		t.Fatalf("open: %d %s", code, out)
	}
	for _, c := range []struct {
		name string
		code int
	}{{"a/b", 400}, {"  ", 400}, {"proj a.v1-x", 409}, {"proj a.v1", 400}} {
		if code, out := post(t, base+"/api/folders/rename", map[string]any{"path": old, "name": c.name}); code != c.code {
			t.Errorf("rename to %q: %d %s, want %d", c.name, code, out, c.code)
		}
	}

	code, out := post(t, base+"/api/folders/rename", map[string]any{"path": old, "name": " proj b "})
	var rep struct{ Path string }
	moved := filepath.Join(work, "proj b")
	if code != 200 || json.Unmarshal(out, &rep) != nil || rep.Path != moved {
		t.Fatalf("rename: %d %s", code, out)
	}
	if exists(old) || !exists(filepath.Join(moved, "sub")) {
		t.Fatal("the folder itself was not renamed")
	}
	check := func(when string) {
		t.Helper()
		for id, want := range map[string]string{"a": moved, "b": filepath.Join(moved, "sub"), "c": sibling} {
			if s := sessionByID(t, base, id); s.Cwd != want {
				t.Errorf("%s: session %s in %s, want %s", when, id, s.Cwd, want)
			}
		}
		var open bool
		for _, f := range getFolders(t, base) {
			if f.Path == old {
				t.Errorf("%s: the old folder still listed", when)
			}
			if f.Path == moved {
				open = f.Open
			}
		}
		if !open {
			t.Errorf("%s: the renamed folder is not open", when)
		}
	}
	check("after the rename")
	for _, p := range []string{
		filepath.Join(projects, projName(moved), "a.jsonl"),
		filepath.Join(projects, projName(moved), "memory", "MEMORY.md"),
		filepath.Join(projects, projName(filepath.Join(moved, "sub")), "b.jsonl"),
		filepath.Join(projects, projName(sibling), "c.jsonl"),
	} {
		if !exists(p) {
			t.Errorf("%s is missing", p)
		}
	}
	if exists(filepath.Join(projects, projName(old))) {
		t.Error("the old project dir is still there")
	}
	resp, body := fetch(t, base+"/api/folders/moves", token)
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"to":`) {
		t.Errorf("moves: %d %s", resp.StatusCode, body)
	}

	base = start()
	check("after a restart")

	// The old name, taken again: its new session is its own.
	os.MkdirAll(old, 0o755)
	writeSession(t, filepath.Join(projects, projName(old), "d.jsonl"), cwdRow("d1", old, time.Now().Add(time.Minute)))
	time.Sleep(2100 * time.Millisecond) // the list refreshes at most every 2 s
	if s := sessionByID(t, base, "d"); s.Cwd != old {
		t.Errorf("a session begun in the old name since: in %s", s.Cwd)
	}
	if _, body := fetch(t, base+"/api/folders/moves", token); string(body) != "[]\n" && string(body) != "[]" {
		t.Errorf("moves once the old name is back: %s", body)
	}
}

// The real thing: a session's folder renamed between turns. The session
// lists under the new folder and its next turn runs there, remembering the
// first; a rename while a turn runs is refused.
func TestRealMoveFolder(t *testing.T) {
	t.Parallel()
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			if provider == "codex" {
				if _, err := codex.FindBinary(); err != nil {
					t.Skip(err)
				}
			}
			base := realServer(t)
			st := openStream(t, base, "")
			pos := 0
			st.wait(t, &pos, "snapshot", func(e server.Ev) bool { return e.Type == "snapshot" })

			body := map[string]any{"text": "Reply with exactly one word: kiwi"}
			if provider == "codex" {
				body["provider"], body["effort"], body["permissionMode"] = "codex", "low", "plan"
			}
			id, cwd := "", ""
			if provider == "codex" {
				cwd = testcwd.New(t)
				body["promptId"], body["cwd"], body["model"] = testcwd.UUID(), cwd, "gpt-5.6-sol"
				code, out := post(t, base+"/api/sessions", body)
				var rep struct{ Session string }
				if code != 202 || json.Unmarshal(out, &rep) != nil {
					t.Fatalf("new session: %d %s", code, out)
				}
				id = rep.Session
				t.Cleanup(func() { removeTestRollout(t, id) })
			} else {
				id, cwd = newTurn(t, base, body)
			}
			if done := st.wait(t, &pos, "kiwi done", turnDone(id)); done.ev.Result == nil || !done.ev.Result.OK {
				t.Fatalf("first turn: %+v", done.ev)
			}
			moved := cwd + "-renamed"
			testcwd.Also(t, moved)
			name := filepath.Base(moved)

			if code, out := post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(), "text": "Reply with exactly one word: lime"}); code != 202 {
				t.Fatalf("send: %d %s", code, out)
			}
			if code, out := post(t, base+"/api/folders/rename", map[string]any{"path": cwd, "name": name}); code != 409 {
				t.Errorf("rename during a turn: %d %s, want 409", code, out)
			}
			st.wait(t, &pos, "lime done", turnDone(id))

			// The process may linger a moment after the result.
			var code int
			var out []byte
			for i := 0; i < 20; i++ {
				if code, out = post(t, base+"/api/folders/rename", map[string]any{"path": cwd, "name": name}); code != 409 {
					break
				}
				time.Sleep(500 * time.Millisecond)
			}
			if code != 200 {
				t.Fatalf("rename: %d %s", code, out)
			}
			if exists(cwd) || !exists(moved) {
				t.Fatal("the folder was not renamed")
			}
			if s := sessionByID(t, base, id); !strings.EqualFold(s.Cwd, moved) {
				t.Errorf("session listed in %s, want %s", s.Cwd, moved)
			}
			if provider == "claude" && !exists(filepath.Join(transcript.ProjectDir(moved), id+".jsonl")) {
				t.Errorf("the transcript did not move to %s", transcript.ProjectDir(moved))
			}

			if code, out := post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(), "text": "What one word did you reply with first? Reply with just that word."}); code != 202 {
				t.Fatalf("send after the rename: %d %s", code, out)
			}
			done := st.wait(t, &pos, "recall done", turnDone(id))
			if r := done.ev.Result; r == nil || !r.OK || oneWord(r.Text) != "kiwi" {
				t.Errorf("after the rename: %+v %s", r, done.ev.Error)
			}
			if s := sessionByID(t, base, id); !strings.EqualFold(s.Cwd, moved) {
				t.Errorf("after a turn there, listed in %s", s.Cwd)
			}
		})
	}
}
