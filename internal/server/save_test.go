package server_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A save writes only over the version it was edited from, keeps the file's
// line ends and BOM, and refuses what it would damage.
func TestFilesSave(t *testing.T) {
	base, root, _ := fileFixture(t)
	write := func(name, body string) { os.WriteFile(filepath.Join(root, name), []byte(body), 0o644) }
	read := func(name string) string { b, _ := os.ReadFile(filepath.Join(root, name)); return string(b) }
	tagOf := func(name string) string {
		resp, _ := fetch(t, fileURL(base, "raw", root, name), token)
		return resp.Header.Get("ETag")
	}
	save := func(name, text, baseTag string) (int, string) {
		code, out := post(t, fileURL(base, "save", root, name), map[string]string{"text": text, "base": baseTag})
		var r struct{ Etag, Error string }
		json.Unmarshal(out, &r)
		return code, r.Etag + r.Error
	}

	// The tag a save returns is the one the viewer then loads.
	write("a.txt", "one\n")
	tag := tagOf("a.txt")
	code, newTag := save("a.txt", "two\n", tag)
	if code != 200 || read("a.txt") != "two\n" || newTag != tagOf("a.txt") {
		t.Fatalf("save: %d %q %q", code, newTag, read("a.txt"))
	}

	// Changed on disk since: refused, nothing written; "*" overwrites.
	write("a.txt", "claude wrote this\n")
	if code, _ := save("a.txt", "mine\n", tag); code != 412 || read("a.txt") != "claude wrote this\n" {
		t.Errorf("stale save: %d %q", code, read("a.txt"))
	}
	if code, _ := save("a.txt", "mine\n", "*"); code != 200 || read("a.txt") != "mine\n" {
		t.Errorf("overwrite: %d %q", code, read("a.txt"))
	}

	// A shorter text truncates; CRLF and a BOM come back.
	write("w.tex", "\xEF\xBB\xBF\\section{A}\r\nlong line here\r\n")
	if code, _ := save("w.tex", "\\section{B}\nx\n", tagOf("w.tex")); code != 200 || read("w.tex") != "\xEF\xBB\xBF\\section{B}\r\nx\r\n" {
		t.Errorf("crlf/bom: %d %q", code, read("w.tex"))
	}

	// Not UTF-8, binary, missing, inside .git, or a credentials file.
	write("latin.txt", "caf\xE9\n")
	if code, _ := save("latin.txt", "cafe\n", "*"); code != 422 || read("latin.txt") != "caf\xE9\n" {
		t.Errorf("latin-1: %d", code)
	}
	write("bin.dat", "a\x00b")
	if code, _ := save("bin.dat", "x", "*"); code != 422 {
		t.Errorf("binary: %d", code)
	}
	if code, _ := save("new.txt", "x", "*"); code != 404 {
		t.Errorf("missing: %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "new.txt")); err == nil {
		t.Error("a save created a file")
	}
	if code, _ := save(".git/config", "y", "*"); code != 403 || read(".git/config") != "x" {
		t.Errorf(".git: %d", code)
	}
	if code, _ := save("../x.txt", "y", "*"); code != 400 {
		t.Errorf("outside: %d", code)
	}
	if code, _ := save("sub/.credentials.json", "y", "*"); code != 403 {
		t.Errorf("credentials: %d", code)
	}
	if code, _ := save("a.txt", "y", ""); code != 400 {
		t.Errorf("no base: %d", code)
	}
}
