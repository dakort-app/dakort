package server_test

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// Deleting a file moves it into the trash and Undo puts it back; folders,
// .git, credentials and paths outside the folder are refused, and a
// restore never writes over a file that took the name meanwhile.
func TestFilesDeleteAndRestore(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "proj")
	trash := filepath.Join(tmp, "trash")
	files := map[string]string{
		"report.docx":      "doc",
		"sub/deep.txt":     "deep",
		".git/config":      "x",
		".git-credentials": "secret",
	}
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	os.WriteFile(filepath.Join(tmp, "outside.txt"), []byte("outside"), 0o644)
	s := server.New(server.Config{Token: token, Trash: trash, Assets: transcript.Dir(filepath.Join(tmp, "assets")),
		Index: &index.Index{Root: filepath.Join(tmp, "projects"), Registry: filepath.Join(tmp, "sessions")}})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)
	base := srv.URL
	if code, out := post(t, base+"/api/folders/open", map[string]string{"path": root}); code != 200 {
		t.Fatalf("open: %d %s", code, out)
	}
	exists := func(name string) bool { _, err := os.Stat(filepath.Join(root, filepath.FromSlash(name))); return err == nil }
	del := func(name string) (int, string) {
		t.Helper()
		code, out := post(t, fileURL(base, "delete", root, name), map[string]any{})
		var r struct{ Trash, Error string }
		json.Unmarshal(out, &r)
		return code, r.Trash + r.Error
	}
	restore := func(entry string) (int, string) {
		t.Helper()
		code, out := post(t, base+"/api/files/restore", map[string]string{"trash": entry})
		var r struct{ Path, Error string }
		json.Unmarshal(out, &r)
		return code, r.Path + r.Error
	}

	// Into the trash and back, in a subfolder too.
	code, entry := del("report.docx")
	if code != 200 || exists("report.docx") {
		t.Fatalf("delete: %d %q", code, entry)
	}
	if b, err := os.ReadFile(filepath.Join(trash, entry, "file")); err != nil || string(b) != "doc" {
		t.Fatalf("not in the trash: %v %q", err, b)
	}
	if code, p := restore(entry); code != 200 || p != "report.docx" || !exists("report.docx") {
		t.Fatalf("restore: %d %q", code, p)
	}
	if _, err := os.Stat(filepath.Join(trash, entry)); err == nil {
		t.Error("the trash entry stayed after a restore")
	}
	if code, _ := restore(entry); code != 404 {
		t.Errorf("restored twice: %d", code)
	}

	// Its folder deleted meanwhile: made again.
	code, entry = del("sub/deep.txt")
	if code != 200 {
		t.Fatalf("delete deep: %d %q", code, entry)
	}
	os.Remove(filepath.Join(root, "sub"))
	if code, p := restore(entry); code != 200 || p != "sub/deep.txt" || !exists("sub/deep.txt") {
		t.Errorf("restore into a removed folder: %d %q", code, p)
	}

	// A new file under the name meanwhile: kept, and the restore refused.
	_, entry = del("report.docx")
	os.WriteFile(filepath.Join(root, "report.docx"), []byte("new"), 0o644)
	if code, _ := restore(entry); code != 409 {
		t.Errorf("restore over a new file: %d", code)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "report.docx")); string(b) != "new" {
		t.Errorf("the new file was written over: %q", b)
	}

	// Refused: a folder, the root, .git, credentials, outside, missing, a bad entry.
	for name, want := range map[string]int{
		"sub":              400,
		"":                 400,
		".":                400,
		".git/config":      403,
		".git-credentials": 403,
		"../outside.txt":   400,
		"nope.txt":         404,
	} {
		if code, msg := del(name); code != want {
			t.Errorf("delete %q: %d %q, want %d", name, code, msg, want)
		}
	}
	if !exists("sub") || !exists(".git/config") || !exists(".git-credentials") {
		t.Error("something refused was deleted")
	}
	if _, err := os.Stat(filepath.Join(tmp, "outside.txt")); err != nil {
		t.Error("the file outside was deleted")
	}
	for _, bad := range []string{"", "made-trash-1-11111111-2222-4333-8444-555555555555", "../trash", "made-filetrash-1-0123456789abcdef"} {
		if code, _ := restore(bad); code != 400 && code != 404 {
			t.Errorf("restore %q: %d", bad, code)
		}
	}
}
