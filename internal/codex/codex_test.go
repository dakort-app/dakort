package codex

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/agent"
	"github.com/dakort-app/dakort/internal/testcwd"
)

// These tests run real turns against the installed Codex on the cheapest
// setting. Each works in a throwaway cwd; the rollout Codex writes under
// ~/.codex/sessions is removed afterwards, after a check that it is the
// test's own (its first line names the madetest- folder).

const testModel, testEffort = "gpt-5.6-sol", "low"

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

func start(t *testing.T, o Options) *Process {
	t.Helper()
	o.Bin = requireCLI(t)
	if o.Model == "" {
		o.Model, o.Effort = testModel, testEffort
	}
	if o.PermissionMode == "" {
		o.PermissionMode = "manual"
	}
	p, err := Start(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.Close()
		removeRollout(t, p.Path())
	})
	return p
}

func removeRollout(t *testing.T, path string) {
	t.Helper()
	if path == "" {
		return
	}
	head := make([]byte, 4096)
	f, err := os.Open(path)
	if err != nil {
		return
	}
	n, _ := f.Read(head)
	f.Close()
	if !bytes.Contains(head[:n], []byte(testcwd.Marker)) {
		t.Errorf("refusing to remove %s: not a test rollout", path)
		return
	}
	if err := os.Remove(path); err != nil {
		t.Errorf("rollout left behind: %v", err)
	}
}

// turn sends and collects events to the result, answering approvals with
// allow when allow is set, else denying them.
func turn(t *testing.T, p *Process, text string, allow bool, images ...agent.Image) (evs []agent.Event, res *agent.Result) {
	t.Helper()
	if err := p.Send(agent.Message{Text: text, Images: images}); err != nil {
		t.Fatal(err)
	}
	timeout := time.After(3 * time.Minute)
	for {
		select {
		case ev, ok := <-p.Events():
			if !ok {
				t.Fatal("events closed before the result")
			}
			evs = append(evs, ev)
			switch ev.Kind {
			case agent.KindPermission:
				var err error
				if allow {
					err = p.Allow(ev.Permission.ID, nil)
				} else {
					err = p.Deny(ev.Permission.ID, "no")
				}
				if err != nil {
					t.Fatal(err)
				}
			case agent.KindResult:
				return evs, ev.Result
			case agent.KindExit:
				t.Fatalf("exited before the result: %v", ev.Err)
			}
		case <-timeout:
			t.Fatal("no result in 3 minutes")
		}
	}
}

func kinds(evs []agent.Event) map[agent.Kind]int {
	m := map[agent.Kind]int{}
	for _, ev := range evs {
		m[ev.Kind]++
	}
	return m
}

func TestRealTurnAndResume(t *testing.T) {
	cwd := testcwd.New(t)
	p := start(t, Options{Cwd: cwd})
	if p.SessionID() == "" || p.Path() == "" {
		t.Fatalf("no thread: id %q path %q", p.SessionID(), p.Path())
	}
	evs, res := turn(t, p, "Reply with the single word ok and nothing else.", true)
	k := kinds(evs)
	if k[agent.KindInit] != 1 || k[agent.KindTextDelta] == 0 || k[agent.KindAssistant] == 0 {
		t.Errorf("events: %v", k)
	}
	var replay bool
	for _, ev := range evs {
		if ev.Kind == agent.KindUser && ev.Replay && ev.UUID != "" {
			replay = true
		}
	}
	if !replay {
		t.Error("no replay of the prompt")
	}
	if !res.OK || res.Interrupted || strings.ToLower(strings.TrimSpace(res.Text)) != "ok" || res.Usage == nil {
		t.Errorf("result: %+v", res)
	}
	if _, err := os.Stat(p.Path()); err != nil {
		t.Errorf("rollout: %v", err)
	}
	id := p.SessionID()
	if err := p.Close(); err != nil {
		t.Error(err)
	}

	q := start(t, Options{Cwd: cwd, Resume: id})
	if q.SessionID() != id {
		t.Fatalf("resumed %s, want %s", q.SessionID(), id)
	}
	_, res = turn(t, q, "Which single word did you reply with just before this? Answer with that word only.", true)
	if !res.OK || !strings.Contains(strings.ToLower(res.Text), "ok") {
		t.Errorf("resumed result: %+v", res)
	}
}

func TestRealApproval(t *testing.T) {
	cwd := testcwd.New(t)
	// A read-only sandbox: writing the file needs an approval.
	p := start(t, Options{Cwd: cwd, PermissionMode: "plan"})
	evs, res := turn(t, p, "Create a file named hello.txt in the current folder containing the word hi. Do it now without asking questions.", true)
	k := kinds(evs)
	if k[agent.KindPermission] == 0 {
		t.Fatalf("no approval request: %v", k)
	}
	for _, ev := range evs {
		if ev.Kind == agent.KindPermission && (ev.Permission.Tool == "" || ev.Permission.Input == nil) {
			t.Errorf("bare permission: %+v", ev.Permission)
		}
	}
	if !res.OK {
		t.Errorf("result: %+v", res)
	}
	if data, err := os.ReadFile(filepath.Join(cwd, "hello.txt")); err != nil || !strings.Contains(string(data), "hi") {
		t.Errorf("hello.txt: %q %v", data, err)
	}

	evs, res = turn(t, p, "Delete hello.txt from the current folder now, without asking.", false)
	if kinds(evs)[agent.KindPermission] == 0 {
		t.Errorf("no approval request for the delete: %v", kinds(evs))
	}
	if !res.OK {
		t.Errorf("result after a denial: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(cwd, "hello.txt")); err != nil {
		t.Error("the denied delete happened anyway")
	}
}

func TestRealInterrupt(t *testing.T) {
	cwd := testcwd.New(t)
	p := start(t, Options{Cwd: cwd, PermissionMode: "dontAsk"})
	if err := p.Send(agent.Message{Text: "Run a shell command that sleeps for 90 seconds (Start-Sleep 90 in PowerShell, sleep 90 elsewhere) and wait for it, then say done."}); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	var res *agent.Result
	interrupted := false
	for res == nil {
		select {
		case ev := <-p.Events():
			switch ev.Kind {
			case agent.KindResult:
				res = ev.Result
			case agent.KindExit:
				t.Fatalf("exited: %v", ev.Err)
			}
		case <-time.After(500 * time.Millisecond):
		}
		if !interrupted && time.Since(started) > 15*time.Second {
			interrupted = true
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := p.Interrupt(ctx); err != nil {
				t.Fatal(err)
			}
			cancel()
		}
		if time.Since(started) > 80*time.Second {
			t.Fatal("no result after the interrupt")
		}
	}
	if !res.Interrupted {
		t.Errorf("result: %+v", res)
	}
}

func TestRealImage(t *testing.T) {
	cwd := testcwd.New(t)
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for i := range img.Pix {
		img.Pix[i] = 255
	}
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, color.RGBA{255, 0, 0, 255})
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	p := start(t, Options{Cwd: cwd})
	_, res := turn(t, p, "What colour is this image? Answer with one word.", true, agent.Image{MediaType: "image/png", Data: buf.Bytes()})
	if !res.OK || !strings.Contains(strings.ToLower(res.Text), "red") {
		t.Errorf("result: %+v", res)
	}
}

// Not signed in (an empty CODEX_HOME, where the rollout lands too): the
// turn fails, after Codex's own retries, in a way the UI can name.
func TestRealNotSignedIn(t *testing.T) {
	p := start(t, Options{Cwd: testcwd.New(t), Env: []string{"CODEX_HOME=" + t.TempDir(), "OPENAI_API_KEY="}})
	_, res := turn(t, p, "Reply with the single word ok and nothing else.", true)
	if res.OK || !res.SignedOut {
		t.Errorf("result: %+v", res)
	}
}

func TestRealModels(t *testing.T) {
	bin := requireCLI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	list, err := Models(ctx, bin)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) == 0 {
		t.Fatal("no models")
	}
	var found bool
	for _, m := range list {
		if m.ID == testModel && len(m.Efforts) > 0 && m.Label != "" {
			found = true
		}
	}
	if !found {
		t.Errorf("%s not in %+v", testModel, list)
	}
}
