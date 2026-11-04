package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/agent"
	"github.com/dakort-app/dakort/internal/testcwd"
	"github.com/dakort-app/dakort/internal/transcript"
)

// These tests run real turns against the installed CLI on the cheapest
// model. Each test works in its own temp cwd and deletes the project folder
// the CLI creates for it, so nothing touches real sessions.

const testModel = "haiku"

func requireCLI(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("real CLI test")
	}
	bin, err := FindBinary()
	if err != nil {
		t.Skip(err)
	}
	return bin
}

// Temp working directories and their cleanup live in internal/testcwd.
var (
	tempCwd    = testcwd.New
	newUUID    = testcwd.UUID
	projectDir = transcript.ProjectDir
)

func start(t *testing.T, o Options) *Process {
	t.Helper()
	if o.Bin == "" {
		o.Bin = requireCLI(t)
	}
	if o.Model == "" {
		o.Model = testModel
	}
	// Stated, not inherited: the permission tests failed once the Claude
	// settings' default became "auto".
	if o.PermissionMode == "" {
		o.PermissionMode = "manual"
	}
	p, err := Start(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	return p
}

type turnLog struct {
	events []agent.Event
	result *agent.Result
	text   string // joined text deltas
	first  time.Duration
	total  time.Duration
}

func (l *turnLog) count(k agent.Kind) int {
	n := 0
	for _, e := range l.events {
		if e.Kind == k {
			n++
		}
	}
	return n
}

// turn sends msg and reads events until the result. onEvent may act on
// events (answer permissions, interrupt) as they arrive.
func turn(t *testing.T, p *Process, msg string, onEvent func(agent.Event)) *turnLog {
	t.Helper()
	if err := p.Send(agent.Message{Text: msg}); err != nil {
		t.Fatal(err)
	}
	return readTurn(t, p, onEvent)
}

func readTurn(t *testing.T, p *Process, onEvent func(agent.Event)) *turnLog {
	t.Helper()
	l := &turnLog{}
	t0 := time.Now()
	timeout := time.After(2 * time.Minute)
	for {
		select {
		case ev, ok := <-p.Events():
			if !ok {
				t.Fatal("events closed before a result")
			}
			l.events = append(l.events, ev)
			if ev.Kind == agent.KindTextDelta {
				if l.first == 0 {
					l.first = time.Since(t0)
				}
				l.text += ev.Text
			}
			if ev.Kind == agent.KindExit {
				t.Fatalf("process exited before a result: %v", ev.Err)
			}
			if onEvent != nil {
				onEvent(ev)
			}
			if ev.Kind == agent.KindResult {
				l.result = ev.Result
				l.total = time.Since(t0)
				t.Logf("turn: ok=%v interrupted=%v reason=%q first text %.2fs, result %.2fs, %d events, text %q",
					l.result.OK, l.result.Interrupted, l.result.TerminalReason,
					l.first.Seconds(), l.total.Seconds(), len(l.events), l.result.Text)
				return l
			}
		case <-timeout:
			t.Fatal("no result within 2 minutes")
		}
	}
}

// exitOf closes p and returns the exit event's error.
func exitOf(t *testing.T, p *Process) error {
	t.Helper()
	t0 := time.Now()
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	var exitErr error
	for ev := range p.Events() {
		if ev.Kind == agent.KindExit {
			exitErr = ev.Err
		}
	}
	t.Logf("exit after close %.2fs, err=%v", time.Since(t0).Seconds(), exitErr)
	return exitErr
}

func oneWord(s string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(s), ".!\"'`*"))
}

func TestNewResumeFork(t *testing.T) {
	t.Parallel()
	cwd := tempCwd(t)
	id := newUUID()

	p := start(t, Options{Cwd: cwd, SessionID: id, ReplayUserMessages: true})
	l := turn(t, p, "Remember the word zebra. Reply with exactly one word: ok", nil)
	if !l.result.OK || oneWord(l.result.Text) != "ok" {
		t.Fatalf("first turn: %+v", l.result)
	}
	if l.text != l.result.Text {
		t.Errorf("deltas %q differ from result %q", l.text, l.result.Text)
	}
	// The composer's context bar takes the window from here.
	if len(l.result.ContextWindows) == 0 {
		t.Error("result has no modelUsage context window")
	}
	for m, n := range l.result.ContextWindows {
		t.Logf("context window %s: %d", m, n)
		if n < 100_000 {
			t.Errorf("context window %s = %d, implausible", m, n)
		}
	}
	var sawInit, sawReplay bool
	for _, e := range l.events {
		if e.Kind == agent.KindInit {
			sawInit = true
			if e.SessionID != id {
				t.Errorf("init session %q, want preassigned %q", e.SessionID, id)
			}
			if e.Cwd != cwd {
				t.Errorf("init cwd %q, want %q", e.Cwd, cwd)
			}
		}
		if e.Kind == agent.KindUser && strings.Contains(string(e.Raw), "zebra") {
			sawReplay = true
			t.Logf("replayed prompt uuid=%q isReplay=%v", e.UUID, strings.Contains(string(e.Raw), `"isReplay":true`))
			if e.UUID == "" {
				t.Error("replayed prompt has no uuid")
			}
		}
	}
	if !sawInit {
		t.Error("no init event")
	}
	if !sawReplay {
		t.Error("ReplayUserMessages gave no user event for the prompt")
	}
	if err := exitOf(t, p); err != nil {
		t.Errorf("exit: %v", err)
	}
	transcript := filepath.Join(projectDir(cwd), id+".jsonl")
	data, err := os.ReadFile(transcript)
	if err != nil {
		t.Fatalf("transcript: %v", err)
	}
	if m := regexp.MustCompile(`"entrypoint":"([^"]*)"`).FindSubmatch(data); m != nil {
		t.Logf("transcript entrypoint=%s", m[1])
	}

	q := start(t, Options{Cwd: cwd, Resume: id})
	l = turn(t, q, "What word did I ask you to remember? Reply with that one word only.", nil)
	if !l.result.OK || oneWord(l.result.Text) != "zebra" {
		t.Fatalf("resumed turn: %+v", l.result)
	}
	for _, e := range l.events {
		if e.Kind == agent.KindInit && e.SessionID != id {
			t.Errorf("resume changed session id to %q", e.SessionID)
		}
	}
	exitOf(t, q)
	before := mustRead(t, transcript)

	f := start(t, Options{Cwd: cwd, Resume: id, Fork: true})
	l = turn(t, f, "Reply with exactly one word: forked", nil)
	if !l.result.OK {
		t.Fatalf("fork turn: %+v", l.result)
	}
	var forkID string
	for _, e := range l.events {
		if e.Kind == agent.KindInit {
			forkID = e.SessionID
		}
	}
	if forkID == "" || forkID == id {
		t.Errorf("fork session id %q, want a new one", forkID)
	}
	exitOf(t, f)
	if !bytes.Equal(before, mustRead(t, transcript)) {
		t.Error("fork modified the original transcript")
	}
	if !strings.Contains(string(before), "zebra") || strings.Contains(string(before), "forked") {
		t.Error("original transcript should hold zebra and not the forked turn")
	}
	if _, err := os.Stat(filepath.Join(projectDir(cwd), forkID+".jsonl")); err != nil {
		t.Errorf("fork transcript: %v", err)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestKeepAliveTwoTurns(t *testing.T) {
	t.Parallel()
	p := start(t, Options{Cwd: tempCwd(t)})
	a := turn(t, p, "Reply with exactly one word: hello", nil)
	b := turn(t, p, "Reply with exactly one word: goodbye", nil)
	if oneWord(a.result.Text) != "hello" || oneWord(b.result.Text) != "goodbye" {
		t.Fatalf("got %q then %q", a.result.Text, b.result.Text)
	}
	if a.count(agent.KindInit) != 1 || b.count(agent.KindInit) != 1 {
		t.Errorf("init events per turn: %d, %d", a.count(agent.KindInit), b.count(agent.KindInit))
	}
	if err := exitOf(t, p); err != nil {
		t.Errorf("exit: %v", err)
	}
}

func TestPermissionAllowAndDeny(t *testing.T) {
	t.Parallel()
	cwd := tempCwd(t)
	p := start(t, Options{Cwd: cwd})
	var asked []*agent.PermissionRequest
	answer := func(allow bool) func(agent.Event) {
		return func(e agent.Event) {
			if e.Kind != agent.KindPermission {
				return
			}
			asked = append(asked, e.Permission)
			t.Logf("permission: tool=%s reason=%q input=%s", e.Permission.Tool, e.Permission.Reason, e.Permission.Input)
			var err error
			if allow {
				err = p.Allow(e.Permission.ID, nil)
			} else {
				err = p.Deny(e.Permission.ID, "The user declined.")
			}
			if err != nil {
				t.Error(err)
			}
		}
	}
	l := turn(t, p, "Use the Bash tool to run exactly this command: echo one > a.txt . Then reply with one word: done", answer(true))
	if len(asked) != 1 || asked[0].Tool != "Bash" || asked[0].ToolUseID == "" {
		t.Fatalf("permission requests: %+v", asked)
	}
	if !l.result.OK {
		t.Fatalf("allowed turn: %+v", l.result)
	}
	if b, err := os.ReadFile(filepath.Join(cwd, "a.txt")); err != nil || strings.TrimSpace(string(b)) != "one" {
		t.Errorf("a.txt after allow: %q %v", b, err)
	}
	if err := p.Allow(asked[0].ID, nil); err == nil {
		t.Error("answering the same request twice should fail")
	}

	l = turn(t, p, "Use the Bash tool to run exactly this command: echo two > b.txt . If it is refused, reply with one word: refused", answer(false))
	if len(asked) != 2 {
		t.Fatalf("permission requests: %d", len(asked))
	}
	if !l.result.OK {
		t.Fatalf("denied turn: %+v", l.result)
	}
	if _, err := os.Stat(filepath.Join(cwd, "b.txt")); err == nil {
		t.Error("b.txt exists after deny")
	}
	var denial bool
	for _, e := range l.events {
		if e.Kind == agent.KindUser && strings.Contains(string(e.Raw), "The user declined.") {
			denial = true
		}
	}
	if !denial {
		t.Error("deny message did not come back as a tool result")
	}
	exitOf(t, p)
}

func TestInterruptWhileStreaming(t *testing.T) {
	t.Parallel()
	p := start(t, Options{Cwd: tempCwd(t)})
	var interrupted time.Time
	l := turn(t, p, "Write the numbers from 1 to 400 separated by spaces, nothing else.", func(e agent.Event) {
		if e.Kind == agent.KindTextDelta && interrupted.IsZero() {
			interrupted = time.Now()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := p.Interrupt(ctx); err != nil {
				t.Errorf("interrupt: %v", err)
			}
		}
	})
	t.Logf("result %.3fs after interrupt", time.Since(interrupted).Seconds())
	if l.result.OK || !l.result.Interrupted {
		t.Fatalf("want an interrupted result, got %+v", l.result)
	}
	if strings.Contains(l.text, "400") {
		t.Error("the full answer streamed; the interrupt came too late to test anything")
	}
	// The same process takes the next turn.
	l = turn(t, p, "Reply with exactly one word: after", nil)
	if !l.result.OK || oneWord(l.result.Text) != "after" {
		t.Fatalf("turn after interrupt: %+v", l.result)
	}
	if err := exitOf(t, p); err != nil {
		t.Errorf("exit: %v", err)
	}
}

func TestInterruptDuringPermission(t *testing.T) {
	t.Parallel()
	cwd := tempCwd(t)
	p := start(t, Options{Cwd: cwd})
	var reqID string
	var cancelled bool
	l := turn(t, p, "Use the Bash tool to run exactly this command: echo three > c.txt", func(e agent.Event) {
		switch e.Kind {
		case agent.KindPermission:
			reqID = e.Permission.ID
			if err := p.Interrupt(context.Background()); err != nil {
				t.Errorf("interrupt: %v", err)
			}
		case agent.KindPermissionCancel:
			cancelled = e.RequestID == reqID
		}
	})
	if reqID == "" || !cancelled {
		t.Errorf("permission %q, cancel seen %v", reqID, cancelled)
	}
	if !l.result.Interrupted {
		t.Fatalf("want interrupted, got %+v", l.result)
	}
	if err := p.Allow(reqID, nil); err == nil {
		t.Error("allowing a cancelled request should fail")
	}
	if _, err := os.Stat(filepath.Join(cwd, "c.txt")); err == nil {
		t.Error("c.txt exists")
	}
	// The last turn failed, so the CLI exits with status 1.
	if err := exitOf(t, p); err == nil {
		t.Log("exit status 0 after an interrupted last turn")
	}
}

func TestFailures(t *testing.T) {
	t.Parallel()
	t.Run("unknown model", func(t *testing.T) {
		t.Parallel()
		p := start(t, Options{Cwd: tempCwd(t), Model: "no-such-model-xyz"})
		l := turn(t, p, "Reply with exactly one word: hello", nil)
		if l.result.OK || l.result.Interrupted || l.result.APIErrorStatus != 404 || l.result.Text == "" {
			t.Fatalf("got %+v", l.result)
		}
		if err := exitOf(t, p); err == nil {
			t.Error("want a non-zero exit after a failed turn")
		}
	})
	t.Run("unknown session", func(t *testing.T) {
		t.Parallel()
		p := start(t, Options{Cwd: tempCwd(t), Resume: newUUID()})
		l := turn(t, p, "Reply with exactly one word: hello", nil)
		if l.result.OK || len(l.result.Errors) == 0 || !strings.Contains(l.result.Errors[0], "No conversation found") {
			t.Fatalf("got %+v", l.result)
		}
		if l.count(agent.KindInit) != 0 {
			t.Error("init before a failed resume")
		}
		err := exitOf(t, p)
		if err == nil || !strings.Contains(err.Error(), "No conversation found") {
			t.Errorf("exit error should carry stderr, got %v", err)
		}
	})
	t.Run("missing binary", func(t *testing.T) {
		t.Parallel()
		_, err := Start(context.Background(), Options{Bin: filepath.Join(t.TempDir(), "nope.exe"), Cwd: t.TempDir()})
		if err == nil {
			t.Fatal("want an error")
		}
	})
	t.Run("missing cwd", func(t *testing.T) {
		t.Parallel()
		_, err := Start(context.Background(), Options{Bin: requireCLI(t)})
		if err == nil {
			t.Fatal("want an error")
		}
	})
	t.Run("send after close", func(t *testing.T) {
		t.Parallel()
		p := start(t, Options{Cwd: tempCwd(t)})
		exitOf(t, p)
		if err := p.Send(agent.Message{Text: "hi"}); err == nil {
			t.Error("want an error")
		}
	})
}

// A CLI that is not signed in fails the turn in a way the UI can name:
// an empty config folder of its own stands for a machine where nobody
// has signed in (sessions land there too, not in ~/.claude).
func TestNotSignedIn(t *testing.T) {
	t.Parallel()
	p := start(t, Options{Cwd: tempCwd(t), Env: []string{"CLAUDE_CONFIG_DIR=" + t.TempDir(), "ANTHROPIC_API_KEY="}})
	l := turn(t, p, "Reply with exactly one word: hello", nil)
	if l.result.OK || !l.result.SignedOut {
		t.Fatalf("got %+v", l.result)
	}
}

// TestCrash kills the CLI from outside mid-turn, as a crash or an OOM would,
// and checks that the consumer learns of it and Interrupt does not hang.
func TestCrash(t *testing.T) {
	t.Parallel()
	p := start(t, Options{Cwd: tempCwd(t)})
	if err := p.Send(agent.Message{Text: "Write the numbers from 1 to 400 separated by spaces, nothing else."}); err != nil {
		t.Fatal(err)
	}
	// Wait for the turn to be under way, then kill.
	for ev := range p.Events() {
		if ev.Kind == agent.KindInit {
			break
		}
		if ev.Kind == agent.KindExit {
			t.Fatalf("exited early: %v", ev.Err)
		}
	}
	if err := p.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	var exitErr error
	var sawExit bool
	timeout := time.After(15 * time.Second)
	for !sawExit {
		select {
		case ev, ok := <-p.Events():
			if !ok {
				t.Fatal("events closed without an exit event")
			}
			if ev.Kind == agent.KindResult {
				t.Error("a result after a kill")
			}
			if ev.Kind == agent.KindExit {
				sawExit, exitErr = true, ev.Err
			}
		case <-timeout:
			t.Fatal("no exit event within 15 s of the kill")
		}
	}
	t.Logf("exit event %.2fs after kill, err=%v", time.Since(t0).Seconds(), exitErr)
	if exitErr == nil {
		t.Error("exit after a kill should carry an error")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	t0 = time.Now()
	err := p.Interrupt(ctx)
	if err == nil || ctx.Err() != nil {
		t.Errorf("interrupt on a dead process: err=%v after %.2fs, want a prompt error", err, time.Since(t0).Seconds())
	}
	if err := p.Send(agent.Message{Text: "hi"}); err == nil {
		t.Error("send on a dead process should fail")
	}
	if err := p.Close(); err != nil {
		t.Errorf("close after crash: %v", err)
	}
}

func TestImage(t *testing.T) {
	t.Parallel()
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{220, 0, 0, 255})
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	p := start(t, Options{Cwd: tempCwd(t)})
	if err := p.Send(agent.Message{
		Text:   "What colour is this image? Reply with one lowercase word.",
		Images: []agent.Image{{MediaType: "image/png", Data: buf.Bytes()}},
	}); err != nil {
		t.Fatal(err)
	}
	l := readTurn(t, p, nil)
	if !l.result.OK || oneWord(l.result.Text) != "red" {
		t.Fatalf("got %+v", l.result)
	}
	exitOf(t, p)
}

func TestEnvironStripsParentSession(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "x")
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "0")
	env := strings.Join(environ([]string{"EXTRA=1"}), "\n")
	for _, bad := range []string{"CLAUDECODE=", "CLAUDE_CODE_SESSION_ID="} {
		if strings.Contains(env, bad) {
			t.Errorf("%s passed through", bad)
		}
	}
	for _, good := range []string{"CLAUDE_CODE_USE_BEDROCK=0", "EXTRA=1"} {
		if !strings.Contains(env, good) {
			t.Errorf("%s missing", good)
		}
	}
}

func TestParseEvent(t *testing.T) {
	cases := []struct {
		line string
		want agent.Kind
	}{
		{`{"type":"system","subtype":"init","session_id":"s","model":"m","cwd":"c"}`, agent.KindInit},
		{`{"type":"system","subtype":"status","status":"requesting"}`, agent.KindOther},
		{`{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"hi"}}}`, agent.KindTextDelta},
		{`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}}`, agent.KindThinkingDelta},
		{`{"type":"stream_event","event":{"type":"message_stop"}}`, agent.KindOther},
		{`{"type":"assistant","uuid":"u","message":{"content":[]}}`, agent.KindAssistant},
		{`{"type":"rate_limit_event"}`, agent.KindOther},
		{`not json`, agent.KindOther},
	}
	for _, c := range cases {
		ev := parseEvent([]byte(c.line))[0]
		if ev.Kind != c.want {
			t.Errorf("%s: kind %s, want %s", c.line, ev.Kind, c.want)
		}
	}
	ev := parseEvent([]byte(`{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"hi"}}}`))[0]
	if ev.Index != 2 || ev.Text != "hi" {
		t.Errorf("delta %+v", ev)
	}
	r := parseEvent([]byte(`{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":"bad model"}`))[0].Result
	if r.OK || r.APIErrorStatus != 404 {
		t.Errorf("is_error must win over subtype: %+v", r)
	}
	r = parseEvent([]byte(`{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_tools"}`))[0].Result
	if !r.Interrupted {
		t.Errorf("aborted_tools should be interrupted: %+v", r)
	}
	r = parseEvent([]byte(`{"type":"result","is_error":false,"modelUsage":{"claude-opus-5-5":{"inputTokens":2,"contextWindow":1000000},"claude-haiku-4-5":{"contextWindow":200000},"x":{}}}`))[0].Result
	if len(r.ContextWindows) != 2 || r.ContextWindows["claude-opus-5-5"] != 1000000 || r.ContextWindows["claude-haiku-4-5"] != 200000 {
		t.Errorf("context windows from modelUsage: %+v", r.ContextWindows)
	}
	var raw map[string]any
	if json.Unmarshal(ev.Raw, &raw) != nil {
		t.Error("raw not kept")
	}
}
