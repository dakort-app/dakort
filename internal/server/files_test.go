package server_test

import (
	"encoding/json"
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
	req, _ := http.NewRequest("GET", fileURL(base, "raw", root, "done.pdf"), nil)
	req.AddCookie(&http.Cookie{Name: "made_token", Value: token})
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
