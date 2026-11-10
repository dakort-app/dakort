package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeGitHub serves one release the way the GitHub API does: the release
// by tag, as the latest, in the list, and its assets as files when asked
// for octet-stream. sums may lie, to test the check.
func fakeGitHub(t *testing.T, tag string, archive []byte, archiveName string, sums string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := map[string]any{"tag_name": tag, "draft": false, "prerelease": strings.Contains(tag, "-"),
			"assets": []map[string]any{
				{"name": archiveName, "url": srv.URL + "/assets/1", "size": len(archive)},
				{"name": "checksums.txt", "url": srv.URL + "/assets/2", "size": len(sums)},
			}}
		switch r.URL.Path {
		case "/repos/dakort-app/dakort/releases/latest", "/repos/dakort-app/dakort/releases/tags/" + tag:
			json.NewEncoder(w).Encode(rel)
		case "/repos/dakort-app/dakort/releases":
			json.NewEncoder(w).Encode([]any{rel})
		case "/assets/1", "/assets/2":
			if r.Header.Get("Accept") != "application/octet-stream" {
				http.Error(w, "asset metadata asked for, not the file", 406)
				return
			}
			if r.URL.Path == "/assets/1" {
				w.Write(archive)
			} else {
				w.Write([]byte(sums))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// pack puts the binary in the archive GoReleaser would make: a zip on
// Windows, a tar.gz elsewhere, with the binary at the top.
func pack(t *testing.T, bin []byte, ver string) (data []byte, name string) {
	t.Helper()
	var buf bytes.Buffer
	if runtime.GOOS == "windows" {
		z := zip.NewWriter(&buf)
		w, _ := z.Create("dakort.exe")
		w.Write(bin)
		z.Close()
		return buf.Bytes(), "dakort_" + ver + "_windows_" + runtime.GOARCH + ".zip"
	}
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "dakort", Mode: 0o755, Size: int64(len(bin)), Typeflag: tar.TypeReg})
	tw.Write(bin)
	tw.Close()
	gz.Close()
	return buf.Bytes(), "dakort_" + ver + "_" + runtime.GOOS + "_" + runtime.GOARCH + ".tar.gz"
}

// dakort update against a fake GitHub: the archive for this system is
// fetched, checked against checksums.txt, the binary in it staged beside
// the installed one and found to run and say its version; with no service
// running it waits there for the next start. A wrong sum leaves nothing.
func TestUpdateStages(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the binary")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "dakort-v2"+exeSuffix())
	build := exec.Command("go", "build", "-ldflags", "-X main.version=v0.0.2-test", "-o", exe, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	bin, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	archive, name := pack(t, bin, "0.0.2-test")
	sum := sha256.Sum256(archive)
	good := hex.EncodeToString(sum[:]) + "  " + name + "\n"

	home := filepath.Join(dir, "madetest-update")
	svc := newService(setupOpts{port: 3999, home: home, name: "DakortTestUpdate"})
	if err := os.MkdirAll(svc.bin(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(svc.exe(), []byte("the installed one"), 0o755); err != nil {
		t.Fatal(err)
	}
	version = "v0.0.1"
	t.Cleanup(func() { version = "dev" })
	opts := func(gh *httptest.Server) updateOpts {
		return updateOpts{port: 3999, home: home, data: filepath.Join(dir, "data"), name: "DakortTestUpdate", api: gh.URL, repo: "dakort-app/dakort"}
	}

	t.Run("wrong sum", func(t *testing.T) {
		gh := fakeGitHub(t, "v0.0.2-test", archive, name, strings.Repeat("0", 64)+"  "+name+"\n")
		var out bytes.Buffer
		err := update(opts(gh), &out)
		if err == nil || !strings.Contains(err.Error(), "does not match checksums.txt") {
			t.Fatalf("a wrong sum was taken: %v\n%s", err, out.String())
		}
		if exists(svc.staged()) {
			t.Error("a build with a wrong sum was staged")
		}
		if left, _ := filepath.Glob(filepath.Join(svc.bin(), "*.part")); len(left) > 0 {
			t.Errorf("the download was left behind: %v", left)
		}
	})

	t.Run("check", func(t *testing.T) {
		gh := fakeGitHub(t, "v0.0.2-test", archive, name, good)
		o := opts(gh)
		o.check = true
		var out bytes.Buffer
		if err := update(o, &out); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), "this is v0.0.1; v0.0.2-test is out") {
			t.Errorf("check said: %s", out.String())
		}
		if exists(svc.staged()) {
			t.Error("-check staged a build")
		}
	})

	t.Run("staged", func(t *testing.T) {
		gh := fakeGitHub(t, "v0.0.2-test", archive, name, good)
		var out bytes.Buffer
		if err := update(opts(gh), &out); err != nil {
			t.Fatalf("%v\n%s", err, out.String())
		}
		if !strings.Contains(out.String(), "v0.0.2-test staged at") || !strings.Contains(out.String(), "takes it at its next start") {
			t.Errorf("update said: %s", out.String())
		}
		said, err := exec.Command(svc.staged(), "-version").Output()
		if err != nil || !strings.Contains(string(said), "v0.0.2-test") {
			t.Errorf("the staged build says %q, %v", said, err)
		}
		if got, _ := os.ReadFile(svc.exe()); string(got) != "the installed one" {
			t.Error("the installed binary was written over; only the service swaps it")
		}
		if left, _ := filepath.Glob(filepath.Join(svc.bin(), "*.part")); len(left) > 0 {
			t.Errorf("the download was left behind: %v", left)
		}
	})

	t.Run("nothing newer", func(t *testing.T) {
		gh := fakeGitHub(t, "v0.0.1", archive, name, good)
		var out bytes.Buffer
		if err := update(opts(gh), &out); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), "nothing to do") {
			t.Errorf("update said: %s", out.String())
		}
	})
}

func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}
