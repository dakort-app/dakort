package server_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/testcwd"
	"github.com/dakort-app/dakort/internal/transcript"
)

// An image pasted in the browser: base64 in the JSON body, through to the
// model, and back out as an asset of the prompt's row.
func TestRealImage(t *testing.T) {
	t.Parallel()
	base := realServer(t)
	st := openStream(t, base, "")
	pos := 0
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{220, 0, 0, 255})
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	id, _ := newTurn(t, base, map[string]any{
		"text":   "What colour is this image? Reply with one lowercase word.",
		"images": []map[string]any{{"mediaType": "image/png", "data": buf.Bytes()}}, // []byte encodes as base64
	})
	done := st.wait(t, &pos, "done", turnDone(id))
	if r := done.ev.Result; r == nil || !r.OK || oneWord(r.Text) != "red" {
		t.Fatalf("image turn: %+v %s", r, done.ev.Error)
	}
	var page struct {
		Rows []transcript.Row `json:"rows"`
	}
	_, body := fetch(t, base+"/api/sessions/"+id+"/rows", token)
	json.Unmarshal(body, &page)
	for _, r := range page.Rows {
		for _, b := range r.Blocks {
			if b.Type == "image" && b.Asset != "" {
				resp, data := fetch(t, base+"/api/assets/"+b.Asset, token)
				if resp.StatusCode != 200 || !bytes.Equal(data, buf.Bytes()) {
					t.Errorf("asset: %d, %d bytes, want the %d sent", resp.StatusCode, len(data), buf.Len())
				}
				return
			}
		}
	}
	t.Errorf("no image block with an asset in %d rows", len(page.Rows))
}

// Beyond the process cap a send is refused with 503 and not remembered,
// so the same send succeeds once a slot frees.
func TestRealCap(t *testing.T) {
	t.Parallel()
	_, base := realServerWith(t, server.Config{MaxTurns: 1})
	st := openStream(t, base, "")
	pos := 0
	first, _ := newTurn(t, base, map[string]any{"text": bashPrompt})
	st.wait(t, &pos, "permission", of(first, "permission"))

	second := map[string]any{"promptId": testcwd.UUID(), "cwd": testcwd.New(t), "model": "haiku", "text": "Reply with exactly one word: plum"}
	if code, body := post(t, base+"/api/sessions", second); code != 503 {
		t.Fatalf("send beyond the cap: %d %s", code, body)
	}
	if code, body := post(t, base+"/api/sessions/"+first+"/interrupt", map[string]any{}); code != 200 {
		t.Fatalf("interrupt: %d %s", code, body)
	}
	st.wait(t, &pos, "first done", turnDone(first))
	// The slot frees once the first process has exited.
	deadline := time.Now().Add(15 * time.Second)
	var code int
	var body []byte
	for {
		if code, body = post(t, base+"/api/sessions", second); code != 503 || time.Now().After(deadline) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	var rep struct {
		Session   string `json:"session"`
		Duplicate bool   `json:"duplicate"`
	}
	if code != 202 || json.Unmarshal(body, &rep) != nil || rep.Duplicate {
		t.Fatalf("retry after the slot freed: %d %s", code, body)
	}
	done := st.wait(t, &pos, "second done", turnDone(rep.Session))
	if r := done.ev.Result; r == nil || !r.OK || oneWord(r.Text) != "plum" {
		t.Fatalf("second turn: %+v %s", r, done.ev.Error)
	}
}

// Shutting the server down mid-turn ends the CLI process: Close returns,
// and the registry no longer shows a live process holding the session.
func TestRealShutdownMidTurn(t *testing.T) {
	t.Parallel()
	s, base := realServerWith(t, server.Config{})
	st := openStream(t, base, "")
	pos := 0
	id, _ := newTurn(t, base, map[string]any{"text": bashPrompt})
	st.wait(t, &pos, "permission", of(id, "permission"))

	idx := index.New()
	idx.Refresh()
	sess, ok := idx.Get(id)
	if !ok || sess.HeldBy == 0 {
		t.Fatalf("before shutdown: session %+v, want it held by the CLI", sess)
	}
	t0 := time.Now()
	closed := make(chan struct{})
	go func() { s.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(30 * time.Second):
		t.Fatal("Close did not return within 30 s")
	}
	t.Logf("Close took %v", time.Since(t0))
	idx.Refresh()
	if sess, _ = idx.Get(id); sess.HeldBy != 0 {
		t.Errorf("after shutdown: still held by live pid %d", sess.HeldBy)
	}
	if code, body := post(t, base+"/api/sessions/"+id+"/send", map[string]any{"promptId": testcwd.UUID(), "text": "hi"}); code != 503 {
		t.Errorf("send after shutdown: %d %s, want 503", code, body)
	}
}
