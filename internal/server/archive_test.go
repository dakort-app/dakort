package server_test

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Archives list their entries without being unpacked: a zip from its
// directory, a tar.gz read through, a lone .gz by its header and size
// trailer; anything else, or a damaged file, is refused.
func TestArchiveList(t *testing.T) {
	base, root, _ := fileFixture(t)

	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	zw.Create("docs/")
	w, _ := zw.Create("docs/readme.txt")
	w.Write([]byte("hello zip"))
	w, _ = zw.Create("top.csv")
	w.Write([]byte("a,b\n"))
	zw.Close()
	os.WriteFile(filepath.Join(root, "bundle.zip"), zb.Bytes(), 0o644)

	var tb bytes.Buffer
	gw := gzip.NewWriter(&tb)
	tw := tar.NewWriter(gw)
	tw.WriteHeader(&tar.Header{Name: "./src/", Typeflag: tar.TypeDir, Mode: 0o755})
	tw.WriteHeader(&tar.Header{Name: "./src/main.go", Size: 12, Mode: 0o644})
	tw.Write([]byte("package main"))
	tw.Close()
	gw.Close()
	os.WriteFile(filepath.Join(root, "code.tar.gz"), tb.Bytes(), 0o644)
	// Cut off half way: what was read before the cut still lists.
	os.WriteFile(filepath.Join(root, "cut.tgz"), tb.Bytes()[:tb.Len()-10], 0o644)

	var gb bytes.Buffer
	g := gzip.NewWriter(&gb)
	g.Name = "data.json"
	g.Write(bytes.Repeat([]byte("x"), 5000))
	g.Close()
	os.WriteFile(filepath.Join(root, "data.json.gz"), gb.Bytes(), 0o644)
	os.WriteFile(filepath.Join(root, "fake.zip"), []byte("not a zip"), 0o644)

	type entry struct {
		Name string
		Size int64
		Dir  bool
	}
	list := func(p string) (int, []entry, bool) {
		t.Helper()
		resp, body := fetch(t, fileURL(base, "archive", root, p), token)
		var out struct {
			Entries   []entry
			Truncated bool
		}
		json.Unmarshal(body, &out)
		return resp.StatusCode, out.Entries, out.Truncated
	}

	if code, e, _ := list("bundle.zip"); code != 200 || len(e) != 3 || e[0] != (entry{"docs", 0, true}) || e[1] != (entry{"docs/readme.txt", 9, false}) {
		t.Errorf("zip: %d %+v", code, e)
	}
	if code, e, cut := list("code.tar.gz"); code != 200 || cut || len(e) != 2 || e[0] != (entry{"src", 0, true}) || e[1] != (entry{"src/main.go", 12, false}) {
		t.Errorf("tar.gz: %d %+v truncated=%v", code, e, cut)
	}
	if code, e, _ := list("data.json.gz"); code != 200 || len(e) != 1 || e[0] != (entry{"data.json", 5000, false}) {
		t.Errorf("gz: %d %+v", code, e)
	}
	if code, _, _ := list("cut.tgz"); code != 200 && code != 422 {
		t.Errorf("cut tar.gz: %d, want a partial list or a refusal", code)
	}
	if code, _, _ := list("fake.zip"); code != 422 {
		t.Errorf("not really a zip: %d, want 422", code)
	}
	if code, _, _ := list("notes.md"); code != 400 {
		t.Errorf("not an archive: %d, want 400", code)
	}
}
