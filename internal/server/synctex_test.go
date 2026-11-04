package server_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// SyncTeX both ways against real pdflatex and synctex: a main file that
// inputs a chapter from a subfolder, so a line of the chapter has to find
// main.pdf on its own.
func TestSynctex(t *testing.T) {
	if testing.Short() {
		t.Skip("runs pdflatex")
	}
	for _, tool := range []string{"pdflatex", "synctex"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " not installed")
		}
	}
	base, root, _ := fileFixture(t)
	os.MkdirAll(filepath.Join(root, "chap"), 0o755)
	os.WriteFile(filepath.Join(root, "main.tex"), []byte("\\documentclass{article}\n\\begin{document}\nOpening words on the first page.\n\\input{chap/intro}\n\\end{document}\n"), 0o644)
	os.WriteFile(filepath.Join(root, "chap", "intro.tex"), []byte("\\newpage\nThe chapter sentence that SyncTeX must find again.\n"), 0o644)
	os.WriteFile(filepath.Join(root, "plain.tex"), []byte("never compiled\n"), 0o644)
	cmd := exec.Command("pdflatex", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "main.tex")
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("pdflatex: %v\n%s", err, out)
	}

	q := func(kind string, v url.Values) (int, []byte) {
		v.Set("root", root)
		resp, body := fetch(t, base+"/api/files/synctex/"+kind+"?"+v.Encode(), token)
		return resp.StatusCode, body
	}

	code, body := q("view", url.Values{"tex": {"chap/intro.tex"}, "line": {"2"}})
	var view struct {
		PDF   string
		Boxes []struct {
			Page       int
			X, Y, W, H float64
		}
	}
	if code != 200 || json.Unmarshal(body, &view) != nil || len(view.Boxes) == 0 {
		t.Fatalf("view: %d %s", code, body)
	}
	b := view.Boxes[0]
	if view.PDF != "main.pdf" || b.Page != 2 || b.W <= 0 || b.H <= 0 || b.Y <= 0 {
		t.Errorf("view: pdf %q, box %+v (want main.pdf, page 2)", view.PDF, b)
	}

	// Back from the middle of that box to the source line.
	code, body = q("edit", url.Values{"pdf": {"main.pdf"}, "page": {fmt.Sprint(b.Page)},
		"x": {fmt.Sprint(b.X + b.W/2)}, "y": {fmt.Sprint(b.Y + b.H/2)}})
	var edit struct {
		Path    string
		Line    int
		Outside bool
	}
	if code != 200 || json.Unmarshal(body, &edit) != nil || edit.Path != "chap/intro.tex" || edit.Line != 2 || edit.Outside {
		t.Errorf("edit: %d %s (want chap/intro.tex line 2)", code, body)
	}

	for _, c := range []struct {
		kind string
		v    url.Values
		want int
	}{
		{"view", url.Values{"tex": {"plain.tex"}, "line": {"1"}, "pdf": {"plain.pdf"}}, 404}, // never compiled
		{"view", url.Values{"tex": {"main.tex"}, "line": {"0"}}, 400},
		{"view", url.Values{"tex": {"../main.tex"}, "line": {"1"}}, 400},
		{"view", url.Values{"tex": {"nope.tex"}, "line": {"1"}}, 404},
		{"edit", url.Values{"pdf": {"main.pdf"}, "page": {"1"}, "x": {"-5"}, "y": {"1"}}, 400},
		{"edit", url.Values{"pdf": {`\Users\x.pdf`}, "page": {"1"}, "x": {"1"}, "y": {"1"}}, 400},
	} {
		if code, body := q(c.kind, c.v); code != c.want {
			t.Errorf("%s %v: %d %s, want %d", c.kind, c.v, code, body, c.want)
		}
	}
}
