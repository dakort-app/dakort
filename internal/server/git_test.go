package server_test

import (
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

// The changes in a project's folder: git's status read into one mark per
// file (modified, added, deleted, untracked) with the branch, and the diff
// of each; a folder below the top of the repository sees only its own
// changes; a folder outside any repository says so, as does one that is
// not open.
func TestGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	f := setup(t)
	base := f.srv.URL
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	write := func(name, body string) {
		p := filepath.Join(repo, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	run("init", "-q", "-b", "madetest-branch")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	run("config", "core.autocrlf", "false")
	write("kept.txt", "one\ntwo\n")
	write("gone.txt", "bye\n")
	write("sub/inner.txt", "inner\n")
	run("add", ".")
	run("commit", "-q", "-m", "first")
	write("kept.txt", "one\nTWO madetest\n")
	os.Remove(filepath.Join(repo, "gone.txt"))
	write("new file.txt", "fresh madetest\n")
	write("staged.txt", "staged\n")
	run("add", "staged.txt")
	write("sub/inner.txt", "inner changed\n")
	write("newdir/a.txt", "a\n")

	for _, p := range []string{repo, filepath.Join(repo, "sub")} {
		if code, out := post(t, base+"/api/folders/open", map[string]string{"path": p}); code != 200 {
			t.Fatalf("open: %d %s", code, out)
		}
	}
	type state struct {
		Repo   bool
		Branch string
		Files  []struct{ Path, St string }
	}
	status := func(root string) (state, map[string]string) {
		t.Helper()
		resp, body := fetch(t, base+"/api/git?root="+url.QueryEscape(root), token)
		if resp.StatusCode != 200 {
			t.Fatalf("status: %d %s", resp.StatusCode, body)
		}
		var st state
		json.Unmarshal(body, &st)
		m := map[string]string{}
		for _, f := range st.Files {
			m[f.Path] = f.St
		}
		return st, m
	}
	st, m := status(repo)
	want := map[string]string{"kept.txt": "M", "gone.txt": "D", "new file.txt": "U", "staged.txt": "A", "sub/inner.txt": "M", "newdir/": "U"}
	if !st.Repo || st.Branch != "madetest-branch" || len(m) != len(want) {
		t.Errorf("status: %+v", st)
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s: %q, want %q (%+v)", k, m[k], v, st.Files)
		}
	}
	if _, m := status(filepath.Join(repo, "sub")); len(m) != 1 || m["inner.txt"] != "M" {
		t.Errorf("a folder below the top: %v", m)
	}

	diff := func(path string) string {
		t.Helper()
		resp, body := fetch(t, base+"/api/git/diff?root="+url.QueryEscape(repo)+"&path="+url.QueryEscape(path), token)
		if resp.StatusCode != 200 {
			t.Fatalf("diff %s: %d %s", path, resp.StatusCode, body)
		}
		var d struct{ Diff string }
		json.Unmarshal(body, &d)
		return d.Diff
	}
	if d := diff("kept.txt"); !strings.Contains(d, "-two") || !strings.Contains(d, "+TWO madetest") {
		t.Errorf("modified: %s", d)
	}
	if d := diff("new file.txt"); !strings.Contains(d, "+fresh madetest") {
		t.Errorf("untracked: %s", d)
	}
	if d := diff("gone.txt"); !strings.Contains(d, "-bye") {
		t.Errorf("deleted: %s", d)
	}
	if d := diff("staged.txt"); !strings.Contains(d, "+staged") {
		t.Errorf("staged: %s", d)
	}
	if resp, _ := fetch(t, base+"/api/git/diff?root="+url.QueryEscape(repo)+"&path=..%2Fx", token); resp.StatusCode != 400 {
		t.Errorf("a path out of the folder: %d", resp.StatusCode)
	}

	// A repository inside an untracked folder of this one speaks for its
	// own files, and its diff comes from it.
	inner := filepath.Join(repo, "newdir", "inner")
	os.MkdirAll(inner, 0o755)
	gitIn(t, inner, "init", "-q", "-b", "madetest-inner")
	os.WriteFile(filepath.Join(inner, "clean.txt"), []byte("clean\n"), 0o644)
	os.WriteFile(filepath.Join(inner, "edit.txt"), []byte("before\n"), 0o644)
	gitIn(t, inner, "add", ".")
	gitIn(t, inner, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "first")
	os.WriteFile(filepath.Join(inner, "edit.txt"), []byte("after madetest\n"), 0o644)
	type full struct {
		Repos []struct{ Path, Branch string }
		Files []struct{ Path, St, Repo string }
	}
	read := func(root string) full {
		t.Helper()
		resp, body := fetch(t, base+"/api/git?root="+url.QueryEscape(root), token)
		if resp.StatusCode != 200 {
			t.Fatalf("status: %d %s", resp.StatusCode, body)
		}
		var st full
		json.Unmarshal(body, &st)
		return st
	}
	// A new repository is looked for again after a minute; a new server
	// has no list yet.
	f2 := setup(t)
	base = f2.srv.URL
	post(t, base+"/api/folders/open", map[string]string{"path": repo})
	got := read(repo)
	byPath := map[string]string{}
	for _, f := range got.Files {
		byPath[f.Path] = f.St + "@" + f.Repo
	}
	if byPath["newdir/inner/edit.txt"] != "M@newdir/inner" || byPath["newdir/"] != "U@" || byPath["kept.txt"] != "M@" {
		t.Errorf("nested: %+v", got.Files)
	}
	if _, ok := byPath["newdir/inner/clean.txt"]; ok {
		t.Errorf("a committed file in the inner repository is marked: %+v", got.Files)
	}
	if len(got.Repos) != 2 || got.Repos[1].Path != "newdir/inner" || got.Repos[1].Branch != "madetest-inner" {
		t.Errorf("repos: %+v", got.Repos)
	}
	if d := diff("newdir/inner/edit.txt"); !strings.Contains(d, "-before") || !strings.Contains(d, "+after madetest") {
		t.Errorf("a file of the inner repository: %s", d)
	}

	// A folder that is no repository, holding repositories: each speaks.
	plain := t.TempDir()
	for _, name := range []string{"one", "two"} {
		d := filepath.Join(plain, name)
		os.MkdirAll(d, 0o755)
		gitIn(t, d, "init", "-q", "-b", "madetest-"+name)
		os.WriteFile(filepath.Join(d, "x.txt"), []byte(name), 0o644)
	}
	os.WriteFile(filepath.Join(plain, "loose.txt"), []byte("loose"), 0o644)
	post(t, base+"/api/folders/open", map[string]string{"path": plain})
	got = read(plain)
	if len(got.Repos) != 2 || len(got.Files) != 2 || got.Files[0].Path != "one/x.txt" || got.Files[0].Repo != "one" || got.Files[1].Path != "two/x.txt" {
		t.Errorf("a folder of repositories: %+v", got)
	}

	empty := t.TempDir()
	post(t, base+"/api/folders/open", map[string]string{"path": empty})
	if st, _ := status(empty); st.Repo {
		t.Errorf("a folder outside any repository: %+v", st)
	}
	if resp, _ := fetch(t, base+"/api/git?root="+url.QueryEscape(t.TempDir()), token); resp.StatusCode != 403 {
		t.Errorf("a folder that is not open: %d", resp.StatusCode)
	}
}
