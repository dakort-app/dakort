package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// An upload creates a new file in the folder and never writes over one;
// it keeps out of .git, credentials and anything outside the folder.
func TestFilesUpload(t *testing.T) {
	base, root, outside := fileFixture(t)
	read := func(name string) string { b, _ := os.ReadFile(filepath.Join(root, filepath.FromSlash(name))); return string(b) }
	upload := func(dir, name, body, ctype string) (int, string) {
		t.Helper()
		u := base + "/api/files/upload?root=" + url.QueryEscape(root) + "&dir=" + url.QueryEscape(dir) + "&name=" + url.QueryEscape(name)
		req, _ := http.NewRequest("POST", u, bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", ctype)
		req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		out, _ := io.ReadAll(resp.Body)
		var r struct{ Path, Error string }
		json.Unmarshal(out, &r)
		return resp.StatusCode, r.Path + r.Error
	}
	const bin = "application/octet-stream"

	// A new name is used as is; a taken one gets a number, the old file stays.
	if code, p := upload("", "report final.docx", "one", bin); code != 200 || p != "report final.docx" || read(p) != "one" {
		t.Fatalf("new: %d %q", code, p)
	}
	if code, p := upload("", "report final.docx", "two", bin); code != 200 || p != "report final (2).docx" || read(p) != "two" || read("report final.docx") != "one" {
		t.Errorf("taken: %d %q", code, p)
	}
	if code, p := upload("", "report final.docx", "three", bin); code != 200 || p != "report final (3).docx" {
		t.Errorf("taken twice: %d %q", code, p)
	}
	if code, p := upload("", "notes.md", "x", bin); code != 200 || p != "notes (2).md" || read("notes.md") != "# hi" {
		t.Errorf("over a fixture file: %d %q", code, p)
	}
	// Into a subfolder; a name with no extension, and one that is all extension.
	if code, p := upload("sub", "Makefile", "m", bin); code != 200 || p != "sub/Makefile" || read(p) != "m" {
		t.Errorf("subfolder: %d %q", code, p)
	}
	if code, p := upload("", ".env", "a", bin); code != 200 || p != ".env" {
		t.Errorf(".env: %d %q", code, p)
	}
	if code, p := upload("", ".env", "b", bin); code != 200 || p != ".env (2)" {
		t.Errorf(".env again: %d %q", code, p)
	}
	// An empty file is still a file.
	if code, p := upload("", "empty.txt", "", bin); code != 200 || p != "empty.txt" {
		t.Errorf("empty: %d %q", code, p)
	}

	// Refused: a form or JSON body, a name with a path in it, a missing
	// folder, .git, credentials, outside the folder, an unknown root.
	if code, _ := upload("", "f.txt", "x", "application/x-www-form-urlencoded"); code != 415 {
		t.Errorf("form: %d", code)
	}
	if code, _ := upload("", "f.txt", "x", "application/json"); code != 415 {
		t.Errorf("json: %d", code)
	}
	for _, name := range []string{"../f.txt", "a/b.txt", `a\b.txt`, "f.txt:s", "", ".", ".."} {
		if code, _ := upload("", name, "x", bin); code != 400 {
			t.Errorf("name %q: %d", name, code)
		}
	}
	if code, _ := upload("nope", "f.txt", "x", bin); code != 404 {
		t.Errorf("missing folder: %d", code)
	}
	if code, _ := upload(".git", "hooks.txt", "x", bin); code != 403 {
		t.Errorf(".git: %d", code)
	}
	if code, _ := upload("", ".git-credentials", "x", bin); code != 403 {
		t.Errorf("credentials: %d", code)
	}
	if code, _ := upload("..", "f.txt", "x", bin); code != 400 {
		t.Errorf("outside: %d", code)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "f.txt")); err == nil {
		t.Error("wrote above the folder")
	}
	u := base + "/api/files/upload?root=" + url.QueryEscape(outside) + "&name=f.txt"
	req, _ := http.NewRequest("POST", u, bytes.NewReader([]byte("x")))
	req.Header.Set("Content-Type", bin)
	req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 403 {
		t.Errorf("unknown root: %v %v", resp.StatusCode, err)
	}
	if _, err := os.Stat(filepath.Join(outside, "f.txt")); err == nil {
		t.Error("wrote into an unknown folder")
	}
}
