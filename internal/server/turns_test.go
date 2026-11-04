package server_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/claude"
	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/testcwd"
	"github.com/dakort-app/dakort/internal/transcript"
)

func post(t *testing.T, url string, body any) (int, []byte) {
	t.Helper()
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "made_token", Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

// stream reads the event stream in the background.
type stream struct {
	mu     sync.Mutex
	evs    []streamEv
	more   chan struct{}
	cancel func()
}

type streamEv struct {
	id string
	ev server.Ev
}

func openStream(t *testing.T, base, last string) *stream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"/api/events?last="+last, nil)
	req.AddCookie(&http.Cookie{Name: "made_token", Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("stream: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	s := &stream{more: make(chan struct{}, 1), cancel: cancel}
	t.Cleanup(cancel)
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 4<<20)
		var id string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "id: "):
				id = line[4:]
			case strings.HasPrefix(line, "data: "):
				var ev server.Ev
				if json.Unmarshal([]byte(line[6:]), &ev) == nil {
					s.mu.Lock()
					s.evs = append(s.evs, streamEv{id, ev})
					s.mu.Unlock()
					select {
					case s.more <- struct{}{}:
					default:
					}
				}
			}
		}
	}()
	return s
}

// wait returns the first event from position *from on that matches, and
// moves *from past it.
func (s *stream) wait(t *testing.T, from *int, what string, match func(server.Ev) bool) streamEv {
	t.Helper()
	deadline := time.After(2 * time.Minute)
	for {
		s.mu.Lock()
		for ; *from < len(s.evs); *from++ {
			if e := s.evs[*from]; match(e.ev) {
				*from++
				s.mu.Unlock()
				return e
			}
		}
		s.mu.Unlock()
		select {
		case <-s.more:
		case <-deadline:
			t.Fatalf("no %s event within 2 minutes", what)
		}
	}
}

func (s *stream) all() []streamEv {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]streamEv(nil), s.evs...)
}

func realServer(t *testing.T) string {
	t.Helper()
	_, url := realServerWith(t, server.Config{})
	return url
}

func realServerWith(t *testing.T, c server.Config) (*server.Server, string) {
	t.Helper()
	if testing.Short() {
		t.Skip("real CLI test")
	}
	if _, err := claude.FindBinary(); err != nil {
		t.Skip(err)
	}
	c.Token, c.Index, c.Assets = token, index.New(), transcript.Dir(t.TempDir())
	s := server.New(c)
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)
	return s, srv.URL
}

// newTurn starts a new session in a fresh test folder and returns its id
// and folder.
func newTurn(t *testing.T, base string, body map[string]any) (string, string) {
	t.Helper()
	cwd := testcwd.New(t)
	body["promptId"], body["cwd"], body["model"] = testcwd.UUID(), cwd, "haiku"
	// Stated, not inherited: the tests that wait for a permission prompt
	// failed once the Claude settings' default became "auto".
	if body["permissionMode"] == nil {
		body["permissionMode"] = "manual"
	}
	code, out := post(t, base+"/api/sessions", body)
	var rep struct{ Session string }
	if code != 202 || json.Unmarshal(out, &rep) != nil {
		t.Fatalf("new session: %d %s", code, out)
	}
	return rep.Session, cwd
}

const bashPrompt = "Use the Bash tool to run exactly this command: echo three > c.txt"

func of(session, typ string) func(server.Ev) bool {
	return func(e server.Ev) bool { return e.Session == session && e.Type == typ }
}

func turnDone(session string) func(server.Ev) bool {
	return func(e server.Ev) bool { return e.Session == session && e.Type == "turn" && e.State == "done" }
}

func oneWord(s string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(s), ".!\"'`*"))
}

// A new session and a second turn, through HTTP and the stream: the ack is
// quick, a repeated send is recognised, the prompt's row id arrives on the
// stream, and a reconnect replays what it missed.
func TestRealTurn(t *testing.T) {
	t.Parallel()
	base := realServer(t)
	st := openStream(t, base, "")
	pos := 0
	st.wait(t, &pos, "snapshot", func(e server.Ev) bool { return e.Type == "snapshot" })

	cwd := testcwd.New(t)
	first := map[string]any{"promptId": testcwd.UUID(), "cwd": cwd, "text": "Reply with exactly one word: kiwi", "model": "haiku"}
	t0 := time.Now()
	code, body := post(t, base+"/api/sessions", first)
	ack := time.Since(t0)
	var rep struct {
		Session   string `json:"session"`
		Duplicate bool   `json:"duplicate"`
	}
	if code != 202 || json.Unmarshal(body, &rep) != nil || rep.Session == "" {
		t.Fatalf("new session: %d %s", code, body)
	}
	t.Logf("ack after %v", ack)
	id := rep.Session

	code, body = post(t, base+"/api/sessions", first)
	var dup struct {
		Session   string `json:"session"`
		Duplicate bool   `json:"duplicate"`
	}
	if code != 200 || json.Unmarshal(body, &dup) != nil || !dup.Duplicate || dup.Session != id {
		t.Errorf("repeated send: %d %s", code, body)
	}

	running := st.wait(t, &pos, "running", func(e server.Ev) bool { return e.Session == id && e.Type == "turn" && e.State == "running" })
	echo := st.wait(t, &pos, "prompt echo", func(e server.Ev) bool { return e.Session == id && e.Type == "appended" && e.PromptID != "" })
	st.wait(t, &pos, "text delta", func(e server.Ev) bool { return e.Session == id && e.Type == "delta" && e.Kind == "text" })
	done := st.wait(t, &pos, "done", turnDone(id))
	if r := done.ev.Result; r == nil || !r.OK || oneWord(r.Text) != "kiwi" {
		t.Fatalf("first turn: %+v %s", r, done.ev.Error)
	}
	t.Logf("first turn done %v after the send", time.Since(t0))

	// The echoed uuid is the prompt's row in the transcript.
	var page struct {
		Rows []transcript.Row `json:"rows"`
	}
	resp, body := fetch(t, base+"/api/sessions/"+id+"/rows", token)
	if resp.StatusCode != 200 || json.Unmarshal(body, &page) != nil {
		t.Fatalf("rows: %d %s", resp.StatusCode, body)
	}
	prompts := 0
	for _, r := range page.Rows {
		if r.PromptText() == first["text"] {
			prompts++
			if r.UUID != echo.ev.UUID {
				t.Errorf("prompt row %s, echo said %s", r.UUID, echo.ev.UUID)
			}
		}
	}
	if prompts != 1 {
		t.Errorf("%d prompt rows; the repeated send must not run twice", prompts)
	}

	// Right away, while the first process may still be exiting.
	t1 := time.Now()
	code, body = post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(), "text": "Reply with exactly one word: lime"})
	if code != 202 {
		t.Fatalf("second send: %d %s", code, body)
	}
	t.Logf("second ack after %v", time.Since(t1))
	done = st.wait(t, &pos, "second done", turnDone(id))
	if r := done.ev.Result; r == nil || !r.OK || oneWord(r.Text) != "lime" {
		t.Fatalf("second turn: %+v %s", r, done.ev.Error)
	}

	// The list tells every device the session's model, so a picker on
	// another device shows haiku rather than the CLI default.
	var list []struct{ ID, Model string }
	if _, body = fetch(t, base+"/api/sessions", token); json.Unmarshal(body, &list) != nil {
		t.Fatal("session list")
	}
	for _, s := range list {
		if s.ID == id && s.Model != "haiku" {
			t.Errorf("list model %q, want haiku", s.Model)
		}
	}

	// The second send named no model: the session's haiku carried over.
	// Its prompt hangs off the first turn's last reply; had a second
	// process opened the session before the first exited, it could hang
	// off an earlier row and fork the transcript.
	page.Rows = nil
	if _, body = fetch(t, base+"/api/sessions/"+id+"/rows", token); json.Unmarshal(body, &page) != nil {
		t.Fatal("rows after second turn")
	}
	var lastReply, secondPrompt transcript.Row
	for _, r := range page.Rows {
		if r.Role == transcript.Assistant && r.Model != "<synthetic>" {
			if !strings.Contains(r.Model, "haiku") {
				t.Errorf("assistant row model %q, want haiku throughout", r.Model)
			}
			if secondPrompt.UUID == "" {
				lastReply = r
			}
		}
		if r.PromptText() == "Reply with exactly one word: lime" {
			secondPrompt = r
		}
	}
	if secondPrompt.UUID == "" || lastReply.UUID == "" {
		t.Fatal("rows: second prompt or first reply missing")
	}
	// The parent may be a line the reader skips (an attachment), so look
	// it up among all lines that carry a uuid.
	raw, err := os.ReadFile(transcript.SessionPath(cwd, id))
	if err != nil {
		t.Fatal(err)
	}
	var parentAt int64 = -1
	for off, line := int64(0), []byte(nil); len(raw) > 0; off += int64(len(line)) {
		i := bytes.IndexByte(raw, '\n')
		if i < 0 {
			break
		}
		line, raw = raw[:i+1], raw[i+1:]
		var l struct {
			UUID string `json:"uuid"`
		}
		if json.Unmarshal(line, &l) == nil && l.UUID == secondPrompt.Parent {
			parentAt = off
		}
	}
	if parentAt < lastReply.Offset {
		t.Errorf("second prompt's parent is at byte %d, before the first turn's last reply at %d: a fork", parentAt, lastReply.Offset)
	}

	// A device that saw only up to "running" catches up by replay.
	again := openStream(t, base, running.id)
	p2 := 0
	again.wait(t, &p2, "replayed first done", turnDone(id))
	got := again.wait(t, &p2, "replayed second done", turnDone(id))
	if evs := again.all(); evs[0].ev.Type == "snapshot" {
		t.Error("reconnect got a snapshot instead of a replay")
	}
	if got.id != done.id {
		t.Errorf("replay reached %s, live stream ended at %s", got.id, done.id)
	}

	// The list shows the session, not running and not held, once the
	// second process is gone.
	deadline := time.Now().Add(10 * time.Second)
	for {
		var list []struct {
			ID      string `json:"id"`
			Running bool   `json:"running"`
			HeldBy  int    `json:"heldBy"`
			Cwd     string `json:"cwd"`
		}
		_, body = fetch(t, base+"/api/sessions", token)
		json.Unmarshal(body, &list)
		var found bool
		for _, s := range list {
			if s.ID == id {
				found = true
				if !s.Running && s.HeldBy == 0 && s.Cwd == cwd {
					return
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("session in list: found=%v, %s", found, body)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// A permission answered from two devices: the second device's snapshot
// shows the pending request, the first answer wins, the second gets 409.
func TestRealPermissionTwoDevices(t *testing.T) {
	t.Parallel()
	base := realServer(t)
	laptop := openStream(t, base, "")
	pos := 0
	cwd := testcwd.New(t)
	code, body := post(t, base+"/api/sessions", map[string]any{
		"promptId": testcwd.UUID(), "cwd": cwd, "model": "haiku", "permissionMode": "manual",
		"text": "Use the Bash tool to run exactly this command: echo one > a.txt . Then reply with one word: done",
	})
	var rep struct{ Session string }
	if code != 202 || json.Unmarshal(body, &rep) != nil {
		t.Fatalf("send: %d %s", code, body)
	}
	id := rep.Session
	ask := laptop.wait(t, &pos, "permission", of(id, "permission"))
	req := ask.ev.Permission
	if req == nil || req.Tool != "Bash" {
		t.Fatalf("permission: %+v", ask.ev)
	}

	phone := openStream(t, base, "")
	pp := 0
	snap := phone.wait(t, &pp, "snapshot", func(e server.Ev) bool { return e.Type == "snapshot" })
	var pending bool
	for _, lt := range snap.ev.Turns {
		for _, p := range lt.Permissions {
			pending = pending || (lt.Session == id && p.ID == req.ID)
		}
	}
	if !pending {
		t.Errorf("phone's snapshot lacks the pending permission: %+v", snap.ev.Turns)
	}

	codes := make([]int, 2)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i], _ = post(t, base+"/api/sessions/"+id+"/permissions/"+req.ID, map[string]any{"allow": true})
		}()
	}
	wg.Wait()
	if !(codes[0] == 200 && codes[1] == 409 || codes[0] == 409 && codes[1] == 200) {
		t.Errorf("two answers: %v, want one 200 and one 409", codes)
	}
	answered := phone.wait(t, &pp, "permissionDone", of(id, "permissionDone"))
	if answered.ev.RequestID != req.ID || answered.ev.Decision != "allow" {
		t.Errorf("permissionDone: %+v", answered.ev)
	}
	done := laptop.wait(t, &pos, "done", turnDone(id))
	if r := done.ev.Result; r == nil || !r.OK {
		t.Fatalf("turn: %+v %s", r, done.ev.Error)
	}
	if b, err := os.ReadFile(filepath.Join(cwd, "a.txt")); err != nil || strings.TrimSpace(string(b)) != "one" {
		t.Errorf("a.txt: %q %v", b, err)
	}
}

// A send while a turn runs is refused; an interrupt ends the turn and
// withdraws its pending permission. The turn is held open on a permission
// prompt: a streamed answer can finish before an HTTP request lands (it
// did under the race detector), which would make the test about timing.
func TestRealBusyAndInterrupt(t *testing.T) {
	t.Parallel()
	base := realServer(t)
	st := openStream(t, base, "")
	pos := 0
	cwd := testcwd.New(t)
	code, body := post(t, base+"/api/sessions", map[string]any{
		"promptId": testcwd.UUID(), "cwd": cwd, "model": "haiku", "permissionMode": "manual",
		"text": "Use the Bash tool to run exactly this command: echo three > c.txt",
	})
	var rep struct{ Session string }
	if code != 202 || json.Unmarshal(body, &rep) != nil {
		t.Fatalf("send: %d %s", code, body)
	}
	id := rep.Session
	ask := st.wait(t, &pos, "permission", of(id, "permission"))
	if code, body = post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(), "text": "hi"}); code != 409 {
		t.Errorf("send during a turn: %d %s", code, body)
	}
	if code, body = post(t, base+"/api/sessions/"+id+"/interrupt", map[string]any{}); code != 200 {
		t.Fatalf("interrupt: %d %s", code, body)
	}
	withdrawn := st.wait(t, &pos, "permissionDone", of(id, "permissionDone"))
	if withdrawn.ev.RequestID != ask.ev.Permission.ID || withdrawn.ev.Decision != "cancelled" {
		t.Errorf("permissionDone: %+v", withdrawn.ev)
	}
	if code, _ = post(t, base+"/api/sessions/"+id+"/permissions/"+ask.ev.Permission.ID, map[string]any{"allow": true}); code != 409 {
		t.Errorf("answering a withdrawn permission: %d", code)
	}
	done := st.wait(t, &pos, "done", turnDone(id))
	if r := done.ev.Result; r == nil || r.OK || !r.Interrupted {
		t.Fatalf("want an interrupted result: %+v %s", r, done.ev.Error)
	}
	if _, err := os.Stat(filepath.Join(cwd, "c.txt")); err == nil {
		t.Error("c.txt exists after the interrupt")
	}
	// Whichever path announced the withdrawal (the CLI's cancel, or the
	// late answer losing the race with it), it was announced once.
	n := 0
	for _, e := range st.all() {
		if e.ev.Type == "permissionDone" && e.ev.RequestID == ask.ev.Permission.ID {
			n++
		}
	}
	if n != 1 {
		t.Errorf("%d permissionDone events for the withdrawn request, want 1", n)
	}
}

// A command left running in the background keeps the CLI process: a send
// meanwhile goes into it, the CLI wakes the model when the command ends,
// and a long one can be stopped from here.
func TestRealBackgroundTask(t *testing.T) {
	t.Parallel()
	base := realServer(t)
	st := openStream(t, base, "")
	pos := 0
	tasks := func(id string, n int) func(server.Ev) bool {
		return func(e server.Ev) bool { return e.Session == id && e.Type == "tasks" && len(e.Tasks) == n }
	}
	id, cwd := newTurn(t, base, map[string]any{"permissionMode": "bypassPermissions",
		"text": "Use the Bash tool with run_in_background set to true to run exactly: sleep 20; echo finished > bg_done.txt . " +
			"Do not wait for it. Reply with the single word: started."})
	st.wait(t, &pos, "a background task", tasks(id, 1))
	st.wait(t, &pos, "the first turn's end", turnDone(id))

	// Held, not running: a send is taken into the same process.
	code, body := post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(), "text": "What is 2+2? Reply with just the number."})
	if code != 202 {
		t.Fatalf("send while the task runs: %d %s", code, body)
	}
	done := st.wait(t, &pos, "the second turn's end", turnDone(id))
	if r := done.ev.Result; r == nil || !strings.Contains(r.Text, "4") {
		t.Fatalf("second turn: %+v %s", done.ev.Result, done.ev.Error)
	}

	// The command ends; the CLI wakes the model by itself.
	st.wait(t, &pos, "the task list emptied", tasks(id, 0))
	st.wait(t, &pos, "the wake-up turn", func(e server.Ev) bool { return e.Session == id && e.Type == "turn" && e.State == "running" })
	if done = st.wait(t, &pos, "the wake-up turn's end", turnDone(id)); done.ev.Result == nil || !done.ev.Result.OK {
		t.Fatalf("wake-up turn: %+v %s", done.ev.Result, done.ev.Error)
	}
	if _, err := os.Stat(filepath.Join(cwd, "bg_done.txt")); err != nil {
		t.Errorf("the background command did not finish: %v", err)
	}

	// A long one, stopped from here.
	code, body = post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(),
		"text": "Use the Bash tool with run_in_background set to true to run exactly: sleep 300 . Do not wait for it. Reply with the single word: started."})
	if code != 202 {
		t.Fatalf("send: %d %s", code, body)
	}
	started := st.wait(t, &pos, "the long task", tasks(id, 1))
	st.wait(t, &pos, "its turn's end", turnDone(id))
	if code, body = post(t, base+"/api/sessions/"+id+"/tasks/nosuch/stop", map[string]any{}); code != 409 {
		t.Errorf("stopping an unknown task: %d %s", code, body)
	}
	if code, body = post(t, base+"/api/sessions/"+id+"/tasks/"+started.ev.Tasks[0].ID+"/stop", map[string]any{}); code != 200 {
		t.Fatalf("stop: %d %s", code, body)
	}
	st.wait(t, &pos, "the task list emptied after the stop", tasks(id, 0))
	// No wake-up follows a stop, so the held process closes at once; a
	// send then starts a fresh one.
	// (That fresh process first answers the stopped task's queued notice
	// with an empty result, which must not end the turn.)
	code, body = post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(), "text": "Reply with exactly one word: kiwi"})
	if code != 202 {
		t.Fatalf("send after the stop: %d %s", code, body)
	}
	if done = st.wait(t, &pos, "the last turn's end", turnDone(id)); done.ev.Result == nil || oneWord(done.ev.Result.Text) != "kiwi" {
		for _, e := range st.all() {
			if e.ev.Session == id && e.ev.Type != "delta" {
				t.Logf("%s %s %s %s prompt=%s tasks=%d text=%q", e.id, e.ev.Type, e.ev.State, e.ev.Kind, e.ev.PromptID, len(e.ev.Tasks), func() string {
					if e.ev.Result != nil {
						return e.ev.Result.Text
					}
					return e.ev.Error
				}())
			}
		}
		t.Fatalf("last turn: %+v %s", done.ev.Result, done.ev.Error)
	}
}

// A session waiting on a background task does not count against the cap:
// with room for one process, another session still gets its turn.
func TestRealHeldFreesSlot(t *testing.T) {
	t.Parallel()
	_, base := realServerWith(t, server.Config{MaxTurns: 1})
	st := openStream(t, base, "")
	pos := 0
	a, _ := newTurn(t, base, map[string]any{"permissionMode": "bypassPermissions",
		"text": "Use the Bash tool with run_in_background set to true to run exactly: sleep 120 . Do not wait for it. Reply with the single word: started."})
	task := st.wait(t, &pos, "a background task", func(e server.Ev) bool { return e.Session == a && e.Type == "tasks" && len(e.Tasks) == 1 })
	st.wait(t, &pos, "the first turn's end", turnDone(a))
	b, _ := newTurn(t, base, map[string]any{"text": "Reply with exactly one word: kiwi"})
	if done := st.wait(t, &pos, "the other session's turn", turnDone(b)); done.ev.Result == nil || oneWord(done.ev.Result.Text) != "kiwi" {
		t.Fatalf("other session: %+v %s", done.ev.Result, done.ev.Error)
	}
	if code, body := post(t, base+"/api/sessions/"+a+"/tasks/"+task.ev.Tasks[0].ID+"/stop", map[string]any{}); code != 200 {
		t.Fatalf("stop: %d %s", code, body)
	}
	time.Sleep(5 * time.Second) // the process closes; its folder can then go
}

// Requests refused before any CLI starts.
func TestSendRefusals(t *testing.T) {
	f := setup(t)
	// s1 is open in another process: this test's own, alive.
	write := func(path, s string) {
		os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(f.registry, "1.json"), fmt.Sprintf(`{"pid":%d,"sessionId":"s1"}`, os.Getpid()))
	code, body := post(t, f.srv.URL+"/api/sessions/s1/send", map[string]any{"promptId": "p", "text": "hi"})
	var held struct {
		Error  string `json:"error"`
		HeldBy int    `json:"heldBy"`
	}
	json.Unmarshal(body, &held)
	if code != 409 || held.HeldBy != os.Getpid() {
		t.Errorf("held session: %d %s", code, body)
	}

	for _, c := range []struct {
		url  string
		body any
		want int
	}{
		{"/api/sessions/s1/send", map[string]any{"text": "hi"}, 400},                             // no promptId
		{"/api/sessions/s1/send", map[string]any{"promptId": "p"}, 400},                          // empty
		{"/api/sessions/nope/send", map[string]any{"promptId": "p", "text": "hi"}, 404},          // unknown
		{"/api/sessions", map[string]any{"promptId": "p", "text": "hi", "cwd": "relative"}, 400}, // cwd
		{"/api/sessions", map[string]any{"promptId": "p", "text": "hi", "cwd": f.path}, 400},     // a file
		{"/api/sessions/s1/permissions/r1", map[string]any{"allow": true}, 409},                  // nothing pending
		{"/api/sessions/s1/interrupt", map[string]any{}, 409},                                    // nothing running
	} {
		if code, body := post(t, f.srv.URL+c.url, c.body); code != c.want {
			t.Errorf("%s %v: %d, want %d (%s)", c.url, c.body, code, c.want, body)
		}
	}

	req, _ := http.NewRequest("POST", f.srv.URL+"/api/sessions/s1/send", strings.NewReader(`{"promptId":"p","text":"hi"}`))
	req.Header.Set("Content-Type", "text/plain")
	req.AddCookie(&http.Cookie{Name: "made_token", Value: token})
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Errorf("form-style post: %v %v", resp.StatusCode, err)
	}
}
