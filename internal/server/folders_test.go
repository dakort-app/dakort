package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

func cwdRow(uuid, cwd string, at time.Time) string {
	c, _ := json.Marshal(cwd)
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":"hello %s"},"uuid":"%s","timestamp":"%s","cwd":%s,"sessionId":"x"}`,
		uuid, uuid, at.UTC().Format(time.RFC3339Nano), c)
}

func writeSession(t *testing.T, path string, lines ...string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

type folder struct {
	Path     string
	Open     bool
	Sessions int
	Missing  bool
}

func getFolders(t *testing.T, base string) []folder {
	t.Helper()
	resp, body := fetch(t, base+"/api/folders", token)
	var fs []folder
	if resp.StatusCode != 200 || json.Unmarshal(body, &fs) != nil {
		t.Fatalf("folders: %d %s", resp.StatusCode, body)
	}
	return fs
}

// Folders group sessions by cwd (ignoring case on Windows), open and close
// across a restart, hide deleted folders, and a closed folder comes back
// when one of its sessions has a new row.
func TestFolders(t *testing.T) {
	root, work := t.TempDir(), t.TempDir()
	other := work // the same folder, spelled with the drive letter's other case
	if runtime.GOOS == "windows" {
		other = strings.ToLower(work[:1]) + work[1:]
		if other == work {
			other = strings.ToUpper(work[:1]) + work[1:]
		}
	}
	long := time.Now().Add(-48 * time.Hour)
	projects := filepath.Join(root, "projects")
	aPath := filepath.Join(projects, "A", "a.jsonl")
	writeSession(t, aPath, cwdRow("a1", work, long))
	writeSession(t, filepath.Join(projects, "B", "b.jsonl"), cwdRow("b1", other, long.Add(time.Hour)))
	writeSession(t, filepath.Join(projects, "C", "c.jsonl"), cwdRow("c1", filepath.Join(root, "gone"), long))

	idx := &index.Index{Root: projects, Registry: filepath.Join(root, "sessions")}
	store := filepath.Join(root, "cfg", "folders.json")
	start := func() string {
		s := server.New(server.Config{Token: token, Index: idx, Assets: transcript.Dir(filepath.Join(root, "assets")), Folders: store})
		srv := httptest.NewServer(s.Handler())
		t.Cleanup(srv.Close)
		t.Cleanup(s.Close)
		return srv.URL
	}
	base := start()

	fs := getFolders(t, base)
	if len(fs) != 1 || fs[0].Path != other || fs[0].Sessions != 2 || fs[0].Open {
		t.Fatalf("folders before opening: %+v (want one, spelled %q, 2 sessions, closed)", fs, other)
	}
	var list []struct{ ID, Folder string }
	_, body := fetch(t, base+"/api/sessions", token)
	json.Unmarshal(body, &list)
	for _, s := range list {
		if s.ID != "c" && s.Folder != other {
			t.Errorf("session %s folder %q, want %q", s.ID, s.Folder, other)
		}
	}

	st := openStream(t, base, "")
	pos := 0
	// Opened under one spelling, the answer names the list's spelling, so
	// the page does not open a second, empty view of the same folder.
	code, out := post(t, base+"/api/folders/open", map[string]string{"path": work})
	var opened struct{ Path string }
	if code != 200 || json.Unmarshal([]byte(out), &opened) != nil || opened.Path != other {
		t.Fatalf("open %q: %d %s (want path %q)", work, code, out, other)
	}
	st.wait(t, &pos, "folders", of("", "folders"))
	if fs = getFolders(t, base); !fs[0].Open {
		t.Fatalf("not open after opening: %+v", fs)
	}
	if fs = getFolders(t, start()); len(fs) != 1 || !fs[0].Open {
		t.Fatalf("open state lost on restart: %+v", fs)
	}

	if code, out := post(t, base+"/api/folders/close", map[string]string{"path": other}); code != 200 {
		t.Fatalf("close: %d %s", code, out)
	}
	if fs = getFolders(t, base); fs[0].Open {
		t.Fatalf("still open after closing: %+v", fs)
	}

	// Work in the folder from elsewhere: it reopens on the next index poll.
	fh, _ := os.OpenFile(aPath, os.O_APPEND|os.O_WRONLY, 0)
	fh.WriteString(cwdRow("a2", work, time.Now().Add(time.Second)) + "\n")
	fh.Close()
	st.wait(t, &pos, "sessions", of("", "sessions"))
	if fs = getFolders(t, base); !fs[0].Open {
		t.Fatalf("closed folder did not reopen on new activity: %+v", fs)
	}

	for _, c := range []struct {
		action, path string
		want         int
	}{
		{"open", filepath.Join(root, "gone"), 400},
		{"open", "relative", 400},
		{"close", "relative", 400},
		{"close", filepath.Join(root, "gone"), 200}, // a deleted folder can still be cleared away
	} {
		if code, out := post(t, base+"/api/folders/"+c.action, map[string]string{"path": c.path}); code != c.want {
			t.Errorf("%s %s: %d, want %d (%s)", c.action, c.path, code, c.want, out)
		}
	}
	if fs = getFolders(t, base); len(fs) != 1 {
		t.Errorf("the deleted folder shows: %+v", fs)
	}
}

// A session another Claude writes gets "appended" when the index poll sees
// it grow, so an open transcript catches up without a reload (it used to
// update only when the stream reconnected).
func TestOutsideAppend(t *testing.T) {
	root, work := t.TempDir(), t.TempDir()
	projects := filepath.Join(root, "projects")
	path := filepath.Join(projects, "A", "a.jsonl")
	writeSession(t, path, cwdRow("a1", work, time.Now().Add(-time.Hour)))
	idx := &index.Index{Root: projects, Registry: filepath.Join(root, "sessions")}
	s := server.New(server.Config{Token: token, Index: idx, Assets: transcript.Dir(filepath.Join(root, "assets")), Folders: filepath.Join(root, "folders.json")})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)
	fetch(t, srv.URL+"/api/sessions", token) // index built

	st := openStream(t, srv.URL, "")
	pos := 0
	fh, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	fh.WriteString(cwdRow("a2", work, time.Now()) + "\n")
	fh.Close()
	st.wait(t, &pos, "appended for the outside write", of("a", "appended"))
}

// Browsing lists folders one level at a time, without hidden ones or
// files, and only for absolute paths that exist.
func TestBrowse(t *testing.T) {
	f := setup(t)
	dir := t.TempDir()
	for _, d := range []string{"Beta", "alpha", ".git", "node_modules", "AppData"} {
		os.Mkdir(filepath.Join(dir, d), 0o755)
	}
	os.WriteFile(filepath.Join(dir, "file.txt"), nil, 0o644)

	var v struct {
		Path, Parent string
		Dirs         []string
	}
	resp, body := fetch(t, f.srv.URL+"/api/browse?path="+url.QueryEscape(dir), token)
	if resp.StatusCode != 200 || json.Unmarshal(body, &v) != nil {
		t.Fatalf("browse: %d %s", resp.StatusCode, body)
	}
	if strings.Join(v.Dirs, ",") != "alpha,Beta" || v.Parent != filepath.Dir(dir) {
		t.Errorf("browse %s: %+v", dir, v)
	}
	if resp, body = fetch(t, f.srv.URL+"/api/browse", token); resp.StatusCode != 200 || json.Unmarshal(body, &v) != nil || v.Path == "" {
		t.Errorf("browse home: %d %s", resp.StatusCode, body)
	}
	for _, p := range []string{"relative", filepath.Join(dir, "nope")} {
		if resp, body := fetch(t, f.srv.URL+"/api/browse?path="+url.QueryEscape(p), token); resp.StatusCode != 400 {
			t.Errorf("browse %s: %d %s", p, resp.StatusCode, body)
		}
	}
}

// Browse can make a new folder where it stands, one level, and never over
// one that exists or with a name that would reach elsewhere.
func TestMkdir(t *testing.T) {
	f := setup(t)
	dir := t.TempDir()
	code, body := post(t, f.srv.URL+"/api/browse/mkdir", map[string]string{"path": dir, "name": " fresh "})
	var v struct{ Path string }
	if code != 200 || json.Unmarshal(body, &v) != nil || v.Path != filepath.Join(dir, "fresh") {
		t.Fatalf("mkdir: %d %s", code, body)
	}
	if fi, err := os.Stat(v.Path); err != nil || !fi.IsDir() {
		t.Fatalf("mkdir: %d %s", code, body)
	}
	for _, name := range []string{"fresh", "", "..", `a\b`, "a/b", "x:y", "dot."} {
		if code, body := post(t, f.srv.URL+"/api/browse/mkdir", map[string]string{"path": dir, "name": name}); code != 400 {
			t.Errorf("mkdir %q: %d %s", name, code, body)
		}
	}
	if code, body := post(t, f.srv.URL+"/api/browse/mkdir", map[string]string{"path": "relative", "name": "x"}); code != 400 {
		t.Errorf("mkdir relative: %d %s", code, body)
	}
}

// Each folder carries the newest change inside it: a file edited two
// levels down counts, though the folder's own time does not move.
func TestBrowseChanged(t *testing.T) {
	f := setup(t)
	dir := t.TempDir()
	old := time.Now().Add(-48 * time.Hour)
	recent := time.Now().Add(-1 * time.Hour)
	deep := filepath.Join(dir, "alpha", "sub", "notes.txt")
	os.MkdirAll(filepath.Dir(deep), 0o755)
	os.WriteFile(deep, nil, 0o644)
	os.Mkdir(filepath.Join(dir, "beta"), 0o755)
	for _, p := range []string{filepath.Join(dir, "alpha", "sub"), filepath.Join(dir, "alpha"), filepath.Join(dir, "beta")} {
		os.Chtimes(p, old, old)
	}
	os.Chtimes(deep, recent, recent)

	var v struct{ Changed map[string]time.Time }
	resp, body := fetch(t, f.srv.URL+"/api/browse?path="+url.QueryEscape(dir), token)
	if resp.StatusCode != 200 || json.Unmarshal(body, &v) != nil {
		t.Fatalf("browse: %d %s", resp.StatusCode, body)
	}
	if v.Changed["alpha"].Sub(recent).Abs() > time.Second {
		t.Errorf("alpha changed %v, want %v (the deep file)", v.Changed["alpha"], recent)
	}
	if v.Changed["beta"].Sub(old).Abs() > time.Second {
		t.Errorf("beta changed %v, want %v", v.Changed["beta"], old)
	}
}

// Pings are data events the browser can see, without an id, so its
// replay cursor does not move.
func TestPing(t *testing.T) {
	root := t.TempDir()
	s := server.New(server.Config{Token: token, PingEvery: 30 * time.Millisecond,
		Index: &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")}})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/events", nil)
	req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	var block []string
	for sc.Scan() {
		if line := sc.Text(); line != "" {
			block = append(block, line)
			continue
		}
		if len(block) == 1 && block[0] == `data: {"type":"ping"}` {
			return
		}
		for _, l := range block {
			if strings.Contains(l, `"ping"`) {
				t.Fatalf("ping event has more than its data line: %q", block)
			}
		}
		block = nil
	}
	t.Fatal("no ping within 5 s")
}
