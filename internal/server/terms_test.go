package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// termReader reads a terminal's output stream in the background.
type termReader struct {
	mu   sync.Mutex
	b    bytes.Buffer
	done chan struct{}
}

func readTerm(t *testing.T, base, id string) (*termReader, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"/api/terms/"+id+"/out", nil)
	req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("out: %d", resp.StatusCode)
	}
	r := &termReader{done: make(chan struct{})}
	go func() {
		defer close(r.done)
		defer resp.Body.Close()
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			r.mu.Lock()
			r.b.Write(buf[:n])
			r.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	return r, cancel
}

func (r *termReader) waitFor(t *testing.T, s string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		ok := strings.Contains(r.b.String(), s)
		r.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	t.Fatalf("no %q in the terminal's output:\n%s", s, r.b.String())
}

// A terminal opens in an open project's folder, runs what is typed, is
// listed for that folder, draws its output again for a second reader (a
// reload), and ends on close; a folder that is not open is refused, as is
// a page without the login.
func TestTerminal(t *testing.T) {
	base, root, outside := fileFixture(t)
	code, out := post(t, base+"/api/terms", map[string]any{"folder": outside, "cols": 80, "rows": 24})
	if code != 403 && code != 404 && code != 400 {
		t.Errorf("a folder that is not open: %d %s", code, out)
	}
	code, out = post(t, base+"/api/terms", map[string]any{"folder": root, "cols": 100, "rows": 30})
	if code != 201 {
		t.Fatalf("open: %d %s", code, out)
	}
	var info struct {
		ID, Name string
		N        int
	}
	json.Unmarshal(out, &info)
	if info.ID == "" || info.N == 0 || info.Name == "" {
		t.Fatalf("info: %s", out)
	}
	t.Cleanup(func() { post(t, base+"/api/terms/"+info.ID+"/close", map[string]any{}) })

	first, stop := readTerm(t, base, info.ID)
	defer stop()
	// A computed answer, so the echo of the typed line does not count.
	typed := "echo madetest-$((20+22))\r"
	if strings.Contains(info.Name, "pwsh") || strings.Contains(info.Name, "powershell") {
		typed = "echo \"madetest-$(20+22)\"\r"
	}
	if code, out := post(t, base+"/api/terms/"+info.ID+"/in", map[string]string{"data": typed}); code != 200 {
		t.Fatalf("in: %d %s", code, out)
	}
	first.waitFor(t, "madetest-42")
	if code, _ := post(t, base+"/api/terms/"+info.ID+"/resize", map[string]int{"cols": 120, "rows": 40}); code != 200 {
		t.Errorf("resize: %d", code)
	}

	// A second reader gets what was printed so far.
	second, stop2 := readTerm(t, base, info.ID)
	defer stop2()
	second.waitFor(t, "madetest-42")

	_, body := fetch(t, base+"/api/terms?folder="+url.QueryEscape(root), token)
	var list []struct{ ID string }
	if json.Unmarshal(body, &list); len(list) != 1 || list[0].ID != info.ID {
		t.Errorf("list: %s", body)
	}
	if resp, _ := fetch(t, base+"/api/terms/"+info.ID+"/out", ""); resp.StatusCode != 401 {
		t.Errorf("without the login: %d", resp.StatusCode)
	}

	if code, _ := post(t, base+"/api/terms/"+info.ID+"/close", map[string]any{}); code != 200 {
		t.Errorf("close: %d", code)
	}
	select {
	case <-first.done:
	case <-time.After(15 * time.Second):
		t.Fatal("the output stream did not end after close")
	}
	if resp, _ := fetch(t, base+"/api/terms/"+info.ID+"/out", token); resp.StatusCode != 404 {
		t.Errorf("a closed terminal: %d", resp.StatusCode)
	}
	_, body = fetch(t, base+"/api/terms?folder="+url.QueryEscape(root), token)
	if strings.TrimSpace(string(body)) != "[]" {
		t.Errorf("list after close: %s", body)
	}
}
