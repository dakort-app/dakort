package server_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/codex"
	"github.com/dakort-app/dakort/internal/testcwd"
)

// A stop tapped during "Starting…", before the CLI has taken the prompt
// up, must still end the turn: the server keeps it and interrupts at the
// turn's init. Both providers.
func TestRealStopEarly(t *testing.T) {
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
			cwd := testcwd.New(t)
			body := map[string]any{"promptId": testcwd.UUID(), "cwd": cwd, "provider": provider, "permissionMode": "manual",
				"text": "Write a 400-word story about a lighthouse keeper, one paragraph at a time."}
			if provider == "codex" {
				body["model"], body["effort"] = "gpt-5.6-sol", "low"
			} else {
				body["model"] = "haiku"
			}
			code, out := post(t, base+"/api/sessions", body)
			var rep struct{ Session string }
			if code != 202 || json.Unmarshal(out, &rep) != nil {
				t.Fatalf("send: %d %s", code, out)
			}
			id := rep.Session
			if provider == "codex" {
				t.Cleanup(func() { removeTestRollout(t, id) })
			}
			t0 := time.Now()
			if code, out = post(t, base+"/api/sessions/"+id+"/interrupt", map[string]any{}); code != 200 {
				t.Fatalf("stop right after the send: %d %s", code, out)
			}
			done := st.wait(t, &pos, "done", turnDone(id))
			if r := done.ev.Result; r == nil || !r.Interrupted {
				t.Fatalf("want an interrupted result: %+v %s", r, done.ev.Error)
			}
			t.Logf("%s: stopped %v after the tap", provider, time.Since(t0))
		})
	}
}
