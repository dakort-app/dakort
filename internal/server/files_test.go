package server_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fileFixture opens a temp folder in the app and fills it.
func fileFixture(t *testing.T) (base, root, outside string) {
	t.Helper()
	f := setup(t)
	root, outside = t.TempDir(), t.TempDir()
	files := map[string]string{
		"notes.md":              "# hi",
		"page.html":             "<script>alert(1)</script>",
		"img.png":               "\x89PNG",
		"sub/deep.txt":          "deep",
		".git/config":           "x",
		".ssh/id_rsa":           "secret",
		"done.pdf":              "%PDF-1.5\nstuff\n%%EOF\n",
		"half.pdf":              "%PDF-1.5\nstuff",
		"sub/.credentials.json": "{}",
	}
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside"), 0o644)
	// Old enough to count as settled.
	old := time.Now().Add(-time.Minute)
	os.Chtimes(filepath.Join(root, "done.pdf"), old, old)
	if code, out := post(t, f.srv.URL+"/api/folders/open", map[string]string{"path": root}); code != 200 {
		t.Fatalf("open: %d %s", code, out)
	}
	return f.srv.URL, root, outside
}

func fileURL(base, kind, root, path string) string {
	return base + "/api/files/" + kind + "?root=" + url.QueryEscape(root) + "&path=" + url.QueryEscape(path)
}

// Audio and video answer byte ranges (Safari plays nothing without them),
// under the same sandbox; an SVG comes as a picture.
func TestFilesMedia(t *testing.T) {
	base, root, _ := fileFixture(t)
	clip := make([]byte, 1000)
	for i := range clip {
		clip[i] = byte(i)
	}
	os.WriteFile(filepath.Join(root, "clip.mp4"), clip, 0o644)
	os.WriteFile(filepath.Join(root, "pic.svg"), []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), 0o644)

	req, _ := http.NewRequest("GET", fileURL(base, "raw", root, "clip.mp4"), nil)
	req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
	req.Header.Set("Range", "bytes=10-19")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	h := resp.Header
	if resp.StatusCode != 206 || h.Get("Content-Range") != "bytes 10-19/1000" || len(body) != 10 || body[0] != 10 ||
		h.Get("Content-Type") != "video/mp4" || h.Get("Content-Security-Policy") != "sandbox" {
		t.Errorf("range: %d %q %q len=%d csp=%q", resp.StatusCode, h.Get("Content-Range"), h.Get("Content-Type"), len(body), h.Get("Content-Security-Policy"))
	}
	if resp, body := fetch(t, fileURL(base, "raw", root, "clip.mp4"), token); resp.StatusCode != 200 || len(body) != 1000 {
		t.Errorf("whole clip: %d len=%d", resp.StatusCode, len(body))
	}

	resp, _ = fetch(t, fileURL(base, "raw", root, "pic.svg"), token)
	if resp.Header.Get("Content-Type") != "image/svg+xml" || resp.Header.Get("Content-Security-Policy") != "sandbox" {
		t.Errorf("svg: %q csp=%q", resp.Header.Get("Content-Type"), resp.Header.Get("Content-Security-Policy"))
	}
}

func TestFilesServe(t *testing.T) {
	base, root, _ := fileFixture(t)

	resp, body := fetch(t, fileURL(base, "list", root, ""), token)
	var ents []struct {
		Name string
		Dir  bool
	}
	if resp.StatusCode != 200 || json.Unmarshal(body, &ents) != nil {
		t.Fatalf("list: %d %s", resp.StatusCode, body)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name)
	}
	if got := strings.Join(names, ","); got != "sub,done.pdf,half.pdf,img.png,notes.md,page.html" {
		t.Errorf("list: %s (folders first; .git and .ssh hidden)", got)
	}

	cases := []struct{ path, ctype string }{
		{"notes.md", "application/octet-stream"},
		{"page.html", "application/octet-stream"}, // never rendered as HTML
		{"img.png", "image/png"},
		{"sub/deep.txt", "application/octet-stream"},
		{"done.pdf", "application/pdf"},
	}
	if runtime.GOOS == "windows" {
		// A backslash separates there; elsewhere it is part of a name.
		cases = append(cases, struct{ path, ctype string }{`sub\deep.txt`, "application/octet-stream"})
	}
	for _, c := range cases {
		resp, _ := fetch(t, fileURL(base, "raw", root, c.path), token)
		h := resp.Header
		if resp.StatusCode != 200 || h.Get("Content-Type") != c.ctype || h.Get("X-Content-Type-Options") != "nosniff" ||
			h.Get("Content-Security-Policy") != "sandbox" || h.Get("Accept-Ranges") != "" {
			t.Errorf("raw %s: %d %q nosniff=%q csp=%q ranges=%q", c.path, resp.StatusCode, h.Get("Content-Type"),
				h.Get("X-Content-Type-Options"), h.Get("Content-Security-Policy"), h.Get("Accept-Ranges"))
		}
	}

	// An HTML file asked for as a page comes as one, still sandboxed; other
	// files ignore the ask.
	for path, want := range map[string]string{"page.html": "text/html; charset=utf-8", "notes.md": "application/octet-stream"} {
		resp, _ := fetch(t, fileURL(base, "raw", root, path)+"&html=1", token)
		if resp.Header.Get("Content-Type") != want || resp.Header.Get("Content-Security-Policy") != "sandbox" {
			t.Errorf("%s as a page: %q csp=%q", path, resp.Header.Get("Content-Type"), resp.Header.Get("Content-Security-Policy"))
		}
	}
	// Opening on the computer: HTML and office documents only (nothing that
	// runs, not even a macro workbook), and never for a request from another
	// device. (A real open would put a window on the screen, so only the
	// refusals are tried.)
	for _, n := range []string{"tool.exe", "run.bat", "book.xlsm"} {
		os.WriteFile(filepath.Join(root, n), []byte("x"), 0o644)
	}
	for _, n := range []string{"notes.md", "tool.exe", "run.bat", "book.xlsm"} {
		if code, _ := post(t, fileURL(base, "open", root, n), map[string]any{}); code != 400 {
			t.Errorf("open %s: %d, want 400", n, code)
		}
	}
	req, _ := http.NewRequest("POST", fileURL(base, "open", root, "page.html"), strings.NewReader("{}"))
	req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	req.Host = "laptop.example.ts.net"
	if r, err := http.DefaultClient.Do(req); err != nil || r.StatusCode != 403 {
		t.Errorf("open from another device: %v %v, want 403", err, r)
	}

	// A PDF still being written is refused, not served truncated.
	if resp, _ := fetch(t, fileURL(base, "raw", root, "half.pdf"), token); resp.StatusCode != 503 {
		t.Errorf("half-written PDF: %d, want 503", resp.StatusCode)
	}
	// The Save button's download is an attachment under the file's name;
	// a view is not.
	if resp, _ := fetch(t, fileURL(base, "raw", root, "sub/deep.txt")+"&download=1", token); resp.Header.Get("Content-Disposition") != `attachment; filename=deep.txt` {
		t.Errorf("download: %q", resp.Header.Get("Content-Disposition"))
	}
	if resp, _ := fetch(t, fileURL(base, "raw", root, "done.pdf"), token); resp.Header.Get("Content-Disposition") != "" {
		t.Errorf("a view came as an attachment: %q", resp.Header.Get("Content-Disposition"))
	}
	// ETag round trip.
	resp, _ = fetch(t, fileURL(base, "raw", root, "done.pdf"), token)
	req, _ = http.NewRequest("GET", fileURL(base, "raw", root, "done.pdf"), nil)
	req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
	req.Header.Set("If-None-Match", resp.Header.Get("ETag"))
	if r2, err := http.DefaultClient.Do(req); err != nil || r2.StatusCode != 304 {
		t.Errorf("If-None-Match: %v %v", err, r2)
	}

	// stat: complete only for a finished, settled PDF.
	for path, want := range map[string]bool{"done.pdf": true, "half.pdf": false} {
		var st struct{ Complete *bool }
		resp, body := fetch(t, fileURL(base, "stat", root, path), token)
		if resp.StatusCode != 200 || json.Unmarshal(body, &st) != nil || st.Complete == nil || *st.Complete != want {
			t.Errorf("stat %s: %d %s, want complete=%v", path, resp.StatusCode, body, want)
		}
	}
	os.WriteFile(filepath.Join(root, "fresh.pdf"), []byte("%PDF\n%%EOF\n"), 0o644)
	var st struct{ Complete *bool }
	_, body = fetch(t, fileURL(base, "stat", root, "fresh.pdf"), token)
	if json.Unmarshal(body, &st); st.Complete == nil || *st.Complete {
		t.Errorf("a PDF written just now should not count as settled: %s", body)
	}

	// The long and short spellings of the root both work.
	if long, err := filepath.EvalSymlinks(root); err == nil && long != root {
		if resp, _ := fetch(t, fileURL(base, "raw", long, "notes.md"), token); resp.StatusCode != 200 {
			t.Errorf("long form of the root %s: %d", long, resp.StatusCode)
		}
	}
}

func TestFilesConfined(t *testing.T) {
	base, root, outside := fileFixture(t)
	home, _ := os.UserHomeDir()

	bad := []struct{ root, path string }{
		{root, `..\` + filepath.Base(outside) + `\secret.txt`},
		{root, "../" + filepath.Base(outside) + "/secret.txt"},
		{root, "sub/../../x"},
		{root, filepath.Join(outside, "secret.txt")},
		{root, `\Users\x`},
		{root, "/etc/passwd"},
		{root, `\\localhost\c$\Windows\win.ini`},
		{root, "C:x"},
		{root, "notes.md:secret"},
		{root, "notes.md::$DATA"},
		{root, "NUL"},
		{root, "COM1"},
		{root, "CON.txt"},
		{root, ".ssh/id_rsa"},
		{root, `.SSH\id_rsa`},
		{root, "sub/.credentials.json"},
		{outside, "secret.txt"},             // not a folder the app knows
		{home, ".claude/.credentials.json"}, // never the home folder
		{filepath.Dir(home), "x"},
		{filepath.VolumeName(root) + `\`, "Windows/win.ini"},
		{"relative", "x"},
	}
	for _, c := range bad {
		resp, body := fetch(t, fileURL(base, "raw", c.root, c.path), token)
		if resp.StatusCode < 400 || resp.StatusCode >= 500 {
			t.Errorf("raw root=%s path=%s: %d %s", c.root, c.path, resp.StatusCode, body)
		}
		if strings.Contains(string(body), "outside") || strings.Contains(string(body), "secret") && resp.StatusCode == 200 {
			t.Errorf("leaked content for %s", c.path)
		}
	}

	if runtime.GOOS != "windows" {
		return
	}
	// A junction inside the folder that points outside it.
	j := filepath.Join(root, "link")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", j, outside).CombinedOutput(); err != nil {
		t.Logf("mklink /J: %v %s; skipping the junction case", err, out)
		return
	}
	defer os.Remove(j) // removes the junction only, not its target
	if resp, body := fetch(t, fileURL(base, "raw", root, "link/secret.txt"), token); resp.StatusCode != 400 && resp.StatusCode != 404 {
		t.Errorf("through a junction: %d %s", resp.StatusCode, body)
	}
	if resp, body := fetch(t, fileURL(base, "list", root, "link"), token); resp.StatusCode == 200 {
		t.Errorf("listing through a junction: %d %s", resp.StatusCode, body)
	}
}
