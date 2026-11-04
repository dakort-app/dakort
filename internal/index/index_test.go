package index_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/agent"
	"github.com/dakort-app/dakort/internal/claude"
	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/testcwd"
	"github.com/dakort-app/dakort/internal/transcript"
)

func userRow(uuid, ts, cwd, text string) string {
	return fmt.Sprintf(`{"parentUuid":null,"type":"user","message":{"role":"user","content":[{"type":"text","text":%q}]},"uuid":%q,"timestamp":%q,"cwd":%q,"sessionId":"x"}`, text, uuid, ts, cwd)
}

func assistantRow(uuid, ts, text string) string {
	return fmt.Sprintf(`{"type":"assistant","message":{"id":"m","role":"assistant","content":[{"type":"text","text":%q}]},"uuid":%q,"timestamp":%q,"sessionId":"x"}`, text, uuid, ts)
}

const costState = `{"type":"cost-state","sessionId":"x","totalCostUSD":0.1}`

func write(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func appendLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(strings.Join(lines, "\n") + "\n"); err != nil {
		t.Fatal(err)
	}
}

func refresh(t *testing.T, x *index.Index) bool {
	t.Helper()
	changed, err := x.Refresh()
	if err != nil {
		t.Fatal(err)
	}
	return changed
}

func get(t *testing.T, x *index.Index, id string) index.Session {
	t.Helper()
	s, ok := x.Get(id)
	if !ok {
		t.Fatalf("session %s not in index", id)
	}
	return s
}

func at(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func TestIndex(t *testing.T) {
	root := t.TempDir()
	x := &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")}
	if refresh(t, x) || len(x.List()) != 0 {
		t.Fatal("a missing projects folder should give an empty, unchanged list")
	}

	a := filepath.Join(x.Root, "C--work-a")
	// Titled by the CLI. The cwd changes later in the session; the first
	// one counts. Bookkeeping after the last row, and an mtime far in the
	// future, must not move Updated.
	titled := filepath.Join(a, "s-titled.jsonl")
	write(t, titled,
		`{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-01T09:59:59Z","sessionId":"x"}`,
		userRow("u1", "2026-10-01T10:00:00Z", `C:\work\a`, "fix the build"),
		`{"type":"ai-title","aiTitle":"Fix the build","sessionId":"x"}`,
		assistantRow("a1", "2026-10-01T10:00:05Z", "done"),
		userRow("u2", "2026-10-01T10:01:00Z", `C:\work\a\sub`, "and the tests"),
		assistantRow("a2", "2026-10-01T10:01:30Z", "done too"),
		costState, `{"type":"mode","mode":"normal","sessionId":"x"}`)
	future := time.Now().Add(30 * 24 * time.Hour)
	os.Chtimes(titled, future, future)
	// No CLI title yet: the prompt stands in.
	untitled := filepath.Join(a, "s-untitled.jsonl")
	write(t, untitled, userRow("u1", "2026-10-02T10:00:00Z", `C:\work\a`, "  what is\n this   file "))
	// No rows at all: titled by the folder, dated by mtime.
	empty := filepath.Join(x.Root, "C--work-b", "s-empty.jsonl")
	write(t, empty, costState)
	// Not sessions.
	write(t, filepath.Join(a, "s-titled", "subagents", "agent-1.jsonl"), userRow("v1", "2026-10-03T10:00:00Z", `C:\work\a`, "sub"))
	write(t, filepath.Join(a, "notes.txt"), "hi")

	if !refresh(t, x) {
		t.Fatal("first refresh should report a change")
	}
	list := x.List()
	if len(list) != 3 {
		t.Fatalf("got %d sessions, want 3: %+v", len(list), list)
	}
	s := get(t, x, "s-titled")
	if s.Title != "Fix the build" || s.Cwd != `C:\work\a` || s.Project != "C--work-a" || s.Provider != "claude" {
		t.Errorf("titled: %+v", s)
	}
	if !s.Created.Equal(at("2026-10-01T10:00:00Z")) || !s.Updated.Equal(at("2026-10-01T10:01:30Z")) {
		t.Errorf("titled times: created %v updated %v", s.Created, s.Updated)
	}
	if u := get(t, x, "s-untitled"); u.Title != "what is this file" {
		t.Errorf("untitled title %q", u.Title)
	}
	e := get(t, x, "s-empty")
	fi, _ := os.Stat(empty)
	if e.Title != "C--work-b" || e.Cwd != "" || !e.Updated.Equal(fi.ModTime()) {
		t.Errorf("empty: %+v", e)
	}
	// Newest activity first: the empty file's mtime is now.
	if list[0].ID != "s-empty" || list[1].ID != "s-untitled" || list[2].ID != "s-titled" {
		t.Errorf("order: %s %s %s", list[0].ID, list[1].ID, list[2].ID)
	}

	if refresh(t, x) {
		t.Error("nothing changed, but refresh says it did")
	}

	// The CLI titles the session after its first turn.
	appendLines(t, untitled,
		`{"type":"ai-title","aiTitle":"Explaining a file","sessionId":"x"}`,
		assistantRow("a1", "2026-10-02T10:00:09Z", "it is a file"))
	if !refresh(t, x) {
		t.Fatal("append not noticed")
	}
	u := get(t, x, "s-untitled")
	if u.Title != "Explaining a file" || !u.Updated.Equal(at("2026-10-02T10:00:09Z")) {
		t.Errorf("after append: %+v", u)
	}
	// Once titled by the CLI, a later different title is not picked up
	// (the head is not read again), but activity is.
	appendLines(t, untitled,
		`{"type":"ai-title","aiTitle":"Explaining one file","sessionId":"x"}`,
		userRow("u2", "2026-10-02T11:00:00Z", `C:\work\a`, "more"))
	refresh(t, x)
	if u := get(t, x, "s-untitled"); u.Title != "Explaining a file" || !u.Updated.Equal(at("2026-10-02T11:00:00Z")) {
		t.Errorf("after second append: %+v", u)
	}

	if err := os.Remove(untitled); err != nil {
		t.Fatal(err)
	}
	if !refresh(t, x) {
		t.Error("removal not noticed")
	}
	if _, ok := x.Get("s-untitled"); ok {
		t.Error("removed session still listed")
	}
}

func TestHeld(t *testing.T) {
	root := t.TempDir()
	x := &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")}
	for _, id := range []string{"live", "stale", "reused"} {
		write(t, filepath.Join(x.Root, "C--w", id+".jsonl"), userRow("u1", "2026-10-01T10:00:00Z", `C:\w`, id))
	}
	// A pid that certainly exited: a child we waited for.
	child := exec.Command(os.Args[0], "-test.run=^$")
	if err := child.Run(); err != nil {
		t.Fatal(err)
	}
	reg := func(pid int, id, procStart string) {
		write(t, filepath.Join(x.Registry, fmt.Sprintf("%d-%s.json", pid, id)),
			fmt.Sprintf(`{"pid":%d,"sessionId":%q,"procStart":%q,"status":"idle"}`, pid, id, procStart))
	}
	reg(os.Getpid(), "live", "")
	reg(child.Process.Pid, "stale", "")
	reg(os.Getpid(), "reused", "1") // our pid, but someone else's start time
	write(t, filepath.Join(x.Registry, "junk.json"), "{not json")

	refresh(t, x)
	if s := get(t, x, "live"); s.HeldBy != os.Getpid() {
		t.Errorf("live: heldBy %d, want %d", s.HeldBy, os.Getpid())
	}
	if s := get(t, x, "stale"); s.HeldBy != 0 {
		t.Errorf("stale registry file for an exited pid counted as held: %d", s.HeldBy)
	}
	if s := get(t, x, "reused"); runtime.GOOS == "windows" && s.HeldBy != 0 {
		t.Errorf("reused pid with a different start time counted as held: %d", s.HeldBy)
	}

	os.Remove(filepath.Join(x.Registry, fmt.Sprintf("%d-live.json", os.Getpid())))
	if !refresh(t, x) {
		t.Error("release not noticed")
	}
	if s := get(t, x, "live"); s.HeldBy != 0 {
		t.Errorf("released session still held by %d", s.HeldBy)
	}
}

// The real projects folder, read only: every session gets an id, a title
// and a time, and a second pass with nothing changed reads no files.
func TestRealProjects(t *testing.T) {
	x := index.New()
	if _, err := os.Stat(x.Root); err != nil {
		t.Skip("no projects folder")
	}
	start := time.Now()
	refresh(t, x)
	first := time.Since(start)
	list := x.List()
	start = time.Now()
	refresh(t, x)
	second := time.Since(start)
	held := 0
	for _, s := range list {
		if s.ID == "" || s.Title == "" || s.Updated.IsZero() || s.Created.IsZero() {
			t.Errorf("incomplete: %+v", s)
		}
		if s.HeldBy != 0 {
			held++
		}
	}
	t.Logf("%d sessions, %d held; build %v, idle poll %v", len(list), held, first, second)
	for _, s := range list[:min(5, len(list))] {
		t.Logf("  %s  %-60s  %s", s.Updated.Local().Format("01-02 15:04"), s.Title, s.Cwd)
	}
}

// A real turn: while the CLI process lives the new session shows as held by
// its pid; after it exits, as released, with its cwd and a title.
func TestRealTurn(t *testing.T) {
	if testing.Short() {
		t.Skip("real CLI test")
	}
	bin, err := claude.FindBinary()
	if err != nil {
		t.Skip(err)
	}
	cwd := testcwd.New(t)
	id := testcwd.UUID()
	p, err := claude.Start(context.Background(), claude.Options{Bin: bin, Cwd: cwd, Model: "haiku", SessionID: id})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	const prompt = "Reply with exactly one word: kiwi"
	if err := p.Send(agent.Message{Text: prompt}); err != nil {
		t.Fatal(err)
	}
	for ev := range p.Events() {
		if ev.Kind == agent.KindResult {
			if !ev.Result.OK {
				t.Fatalf("turn failed: %+v", ev.Result)
			}
			break
		}
	}
	// The CLI reports the result before its rows are in the file; under
	// load the file can lag by a moment (seen once in a full test run).
	x := index.New()
	for deadline := time.Now().Add(10 * time.Second); ; {
		refresh(t, x)
		if _, ok := x.Get(id); ok || time.Now().After(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	s := get(t, x, id)
	if s.HeldBy != p.PID() {
		t.Errorf("while running: heldBy %d, want the CLI's pid %d", s.HeldBy, p.PID())
	}
	if s.Cwd != cwd || s.Path != transcript.SessionPath(cwd, id) {
		t.Errorf("session: %+v", s)
	}
	p.Close()
	refresh(t, x)
	s = get(t, x, id)
	if s.HeldBy != 0 {
		t.Errorf("after exit: still held by %d", s.HeldBy)
	}
	if s.Title == "" || s.Updated.IsZero() {
		t.Errorf("after exit: %+v", s)
	}
	t.Logf("title %q", s.Title)
}
