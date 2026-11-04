package index_test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/dakort-app/dakort/internal/index"
)

func codexMeta(id, ts, cwd string) string {
	return fmt.Sprintf(`{"timestamp":%q,"ordinal":0,"type":"session_meta","payload":{"id":%q,"timestamp":%q,"cwd":%q,"cli_version":"0.163.0"}}`, ts, id, ts, cwd)
}

func codexPrompt(itemID, ts, text string) string {
	return fmt.Sprintf(`{"timestamp":%q,"ordinal":1,"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","id":%q,"content":[{"type":"text","text":%q}]}}}`, ts, itemID, text)
}

func codexReply(msgID, ts, text string) string {
	return fmt.Sprintf(`{"timestamp":%q,"ordinal":2,"type":"response_item","payload":{"type":"message","id":%q,"role":"assistant","content":[{"type":"output_text","text":%q}]}}`, ts, msgID, text)
}

func codexTurnContext(ts, model, approval, sandbox string) string {
	return fmt.Sprintf(`{"timestamp":%q,"ordinal":3,"type":"turn_context","payload":{"model":%q,"effort":"low","approval_policy":%q,"approvals_reviewer":"user","sandbox_policy":{"type":%q}}}`, ts, model, approval, sandbox)
}

func TestCodexIndex(t *testing.T) {
	root := t.TempDir()
	x := &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions"),
		CodexRoot: filepath.Join(root, "codex"), CodexIndex: filepath.Join(root, "session_index.jsonl")}
	id := "01a18505-e800-7fc1-a19e-1688d38eee32"
	path := filepath.Join(x.CodexRoot, "2026", "10", "28", "rollout-2026-10-28T17-18-39-"+id+".jsonl")
	write(t, path,
		codexMeta(id, "2026-10-29T00:18:39.000Z", `C:\work\a`),
		codexTurnContext("2026-10-29T00:18:39.500Z", "gpt-5.6-sol", "on-request", "workspace-write"),
		codexPrompt("item-1", "2026-10-29T00:18:40.000Z", "make hello.txt say hi"),
		codexReply("msg_1", "2026-10-29T00:18:45.000Z", "Done."),
		`{"timestamp":"2026-10-29T00:18:46.000Z","ordinal":4,"type":"event_msg","payload":{"type":"task_complete"}}`)
	// Not rollouts: a stray file, and one at the wrong depth.
	write(t, filepath.Join(x.CodexRoot, "2026", "10", "28", "notes.jsonl"), codexMeta("x", "2026-10-29T00:00:00Z", "C:\\x"))
	write(t, filepath.Join(x.CodexRoot, "2026", "rollout-2026-01-01T00-00-00-"+id+".jsonl"), codexMeta("y", "2026-01-01T00:00:00Z", "C:\\y"))

	if !refresh(t, x) {
		t.Fatal("first refresh should report a change")
	}
	if n := len(x.List()); n != 1 {
		t.Fatalf("got %d sessions, want 1: %+v", n, x.List())
	}
	s := get(t, x, id)
	if s.Provider != "codex" || s.Cwd != `C:\work\a` || s.Title != "make hello.txt say hi" || s.Path != path {
		t.Errorf("session: %+v", s)
	}
	if !s.Created.Equal(at("2026-10-29T00:18:39Z")) || !s.Updated.Equal(at("2026-10-29T00:18:45Z")) {
		t.Errorf("times: created %v updated %v", s.Created, s.Updated)
	}
	if s.Used.Model != "gpt-5.6-sol" || s.Used.Mode != "manual" {
		t.Errorf("used: %+v", s.Used)
	}
	if refresh(t, x) {
		t.Error("nothing changed, but refresh says it did")
	}

	// Codex names the thread in its own index; a later line for the same id wins.
	write(t, x.CodexIndex,
		`{"id":"`+id+`","thread_name":"Hello file","updated_at":"2026-10-29T00:18:46Z"}`,
		`{"id":"other","thread_name":"Other","updated_at":"2026-10-29T00:18:46Z"}`,
		`{"id":"`+id+`","thread_name":"  Make  hello.txt ","updated_at":"2026-10-29T00:19:46Z"}`)
	if !refresh(t, x) {
		t.Fatal("a new name should count as a change")
	}
	if s := get(t, x, id); s.Title != "Make hello.txt" {
		t.Errorf("named: %q", s.Title)
	}
	if refresh(t, x) {
		t.Error("the names did not change, but refresh says something did")
	}

	// A new turn with other settings: Updated and Used move, the name stays.
	appendLines(t, path,
		codexTurnContext("2026-10-29T01:00:00.000Z", "gpt-6-sol", "never", "danger-full-access"),
		codexPrompt("item-2", "2026-10-29T01:00:01.000Z", "and now?"),
		codexReply("msg_2", "2026-10-29T01:00:05.000Z", "Still here."))
	if !refresh(t, x) {
		t.Fatal("an appended turn should count as a change")
	}
	s = get(t, x, id)
	if s.Title != "Make hello.txt" || !s.Updated.Equal(at("2026-10-29T01:00:05Z")) || s.Used.Model != "gpt-6-sol" || s.Used.Mode != "bypassPermissions" {
		t.Errorf("after the turn: %+v", s)
	}

	// Gone from disk: gone from the list.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if !refresh(t, x) || len(x.List()) != 0 {
		t.Errorf("a removed rollout should leave the list: %+v", x.List())
	}
}

// A guardian review is a thread Codex starts by itself, in its own rollout
// (session_meta as written by 0.163.0, trimmed). It is not a session.
func TestCodexSubagentHidden(t *testing.T) {
	root := t.TempDir()
	x := &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions"),
		CodexRoot: filepath.Join(root, "codex"), CodexIndex: filepath.Join(root, "session_index.jsonl")}
	parent := "01a18ebf-4f43-7571-b695-b49f7ea14217"
	child := "01a18f75-3850-75e0-88df-5ae081f6ff3a"
	dir := filepath.Join(x.CodexRoot, "2026", "10", "30")
	write(t, filepath.Join(dir, "rollout-2026-10-30T14-37-44-"+parent+".jsonl"),
		codexMeta(parent, "2026-10-30T21:37:45.000Z", `c:\work\a`),
		codexPrompt("item-1", "2026-10-30T21:37:46.000Z", "is figure 2.1 good?"))
	childPath := filepath.Join(dir, "rollout-2026-10-30T17-56-26-"+child+".jsonl")
	write(t, childPath,
		`{"timestamp":"2026-10-31T00:56:26.794Z","ordinal":0,"type":"session_meta","payload":{"session_id":"`+parent+`","id":"`+child+`","parent_thread_id":"`+parent+`","timestamp":"2026-10-31T00:56:26.572Z","cwd":"C:\\work\\a","cli_version":"0.163.0","source":{"subagent":{"other":"guardian"}},"thread_source":"guardian_review"}}`,
		codexPrompt("item-1", "2026-10-31T00:56:27.000Z", "judge this action"))
	refresh(t, x)
	if l := x.List(); len(l) != 1 || l[0].ID != parent {
		t.Fatalf("want only the parent listed: %+v", l)
	}
	if _, ok := x.Get(child); ok {
		t.Error("Get found the guardian thread")
	}
	// It grows (read from the old entry, not the head): still hidden.
	appendLines(t, childPath, codexReply("msg_1", "2026-10-31T00:56:29.000Z", "allow"))
	refresh(t, x)
	if l := x.List(); len(l) != 1 {
		t.Errorf("after growing: %+v", l)
	}
}
