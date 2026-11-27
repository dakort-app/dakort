package server_test

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// gitOut runs git in dir and returns its output, failing the test on an
// error.
func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return string(out)
}

type gitFixture struct {
	base, root, other, bare string
}

// newGitFixture makes a repository with a bare one as its remote (main
// pushed and tracked), a second clone of the remote to change it from,
// and a server with a trash that has the repository open.
func newGitFixture(t *testing.T) gitFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	// The machine's own git settings (signing, hooks, a default branch)
	// stay out of it.
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.com")
	tmp := t.TempDir()
	f := gitFixture{root: filepath.Join(tmp, "work"), other: filepath.Join(tmp, "other"), bare: filepath.Join(tmp, "remote.git")}
	gitOut(t, tmp, "init", "-q", "--bare", "-b", "main", f.bare)
	os.MkdirAll(f.root, 0o755)
	gitOut(t, f.root, "init", "-q", "-b", "main")
	gitOut(t, f.root, "config", "core.autocrlf", "false")
	write(t, f.root, "a.txt", numbered(1, 30))
	write(t, f.root, "b.txt", "bee\n")
	write(t, f.root, "x.txt", "shared\n")
	gitOut(t, f.root, "add", ".")
	gitOut(t, f.root, "commit", "-q", "-m", "first")
	gitOut(t, f.root, "remote", "add", "origin", f.bare)
	gitOut(t, f.root, "push", "-q", "-u", "origin", "main")
	gitOut(t, tmp, "clone", "-q", f.bare, f.other)
	gitOut(t, f.other, "config", "core.autocrlf", "false")

	s := server.New(server.Config{Token: token, Trash: filepath.Join(tmp, "trash"), Assets: transcript.Dir(filepath.Join(tmp, "assets")),
		Index: &index.Index{Root: filepath.Join(tmp, "projects"), Registry: filepath.Join(tmp, "sessions")}})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)
	f.base = srv.URL
	if code, out := post(t, f.base+"/api/folders/open", map[string]string{"path": f.root}); code != 200 {
		t.Fatalf("open: %d %s", code, out)
	}
	return f
}

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(name))
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, dir, name string) string {
	t.Helper()
	b, _ := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
	return string(b)
}

func numbered(from, to int) string {
	var b strings.Builder
	for i := from; i <= to; i++ {
		b.WriteString("line " + strconv.Itoa(i) + "\n")
	}
	return b.String()
}

// op posts to /api/git/<name> and decodes the answer into a map.
func (f gitFixture) op(t *testing.T, name string, body map[string]any) (int, map[string]any) {
	t.Helper()
	if _, ok := body["root"]; !ok {
		body["root"] = f.root
	}
	code, out := post(t, f.base+"/api/git/"+name, body)
	var m map[string]any
	json.Unmarshal(out, &m)
	return code, m
}

func (f gitFixture) must(t *testing.T, name string, body map[string]any) map[string]any {
	t.Helper()
	code, m := f.op(t, name, body)
	if code != 200 {
		t.Fatalf("%s %v: %d %v", name, body, code, m)
	}
	return m
}

type sideDiff struct {
	Diff  string
	Hunks []string
}

func (f gitFixture) diff(t *testing.T, path, side string) sideDiff {
	t.Helper()
	resp, body := fetch(t, f.base+"/api/git/diff?root="+url.QueryEscape(f.root)+"&path="+url.QueryEscape(path)+"&side="+side, token)
	if resp.StatusCode != 200 {
		t.Fatalf("diff %s %s: %d %s", path, side, resp.StatusCode, body)
	}
	var d sideDiff
	json.Unmarshal(body, &d)
	return d
}

type statusFile struct {
	Path, St, X, Y string
	IA, ID, WA, WD int
}
type statusRepo struct {
	Path, Branch, Upstream, Head, Back string
	Ahead, Behind                      int
	Detached, Remote                   bool
}

func (f gitFixture) status(t *testing.T) (statusRepo, map[string]statusFile) {
	t.Helper()
	resp, body := fetch(t, f.base+"/api/git?root="+url.QueryEscape(f.root), token)
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d %s", resp.StatusCode, body)
	}
	var st struct {
		Repos []statusRepo
		Files []statusFile
	}
	json.Unmarshal(body, &st)
	m := map[string]statusFile{}
	for _, f := range st.Files {
		m[f.Path] = f
	}
	if len(st.Repos) == 0 {
		t.Fatalf("no repository: %s", body)
	}
	return st.Repos[0], m
}

// Staging, unstaging and discarding files and hunks, with Undo, and every
// path the server must refuse.
func TestGitStageAndDiscard(t *testing.T) {
	f := newGitFixture(t)
	// Two hunks in a.txt, far apart. B.txt staged. C.txt new.
	a := strings.Replace(numbered(1, 30), "line 2\n", "line 2 changed\n", 1)
	a = strings.Replace(a, "line 25\n", "line 25 changed\n", 1)
	write(t, f.root, "a.txt", a)
	write(t, f.root, "b.txt", "bee\nbuzz\n")
	gitOut(t, f.root, "add", "b.txt")
	write(t, f.root, "c.txt", "one\ntwo\nthree")

	repo, m := f.status(t)
	if repo.Branch != "main" || repo.Upstream != "origin/main" || !repo.Remote || len(repo.Head) != 7 {
		t.Errorf("repo: %+v", repo)
	}
	if g := m["a.txt"]; g.X != "" || g.Y != "M" || g.WA != 2 || g.WD != 2 {
		t.Errorf("a.txt: %+v", g)
	}
	if g := m["b.txt"]; g.X != "M" || g.Y != "" || g.IA != 1 || g.ID != 0 {
		t.Errorf("b.txt: %+v", g)
	}
	if g := m["c.txt"]; g.Y != "U" || g.St != "U" || g.WA != 3 {
		t.Errorf("c.txt: %+v", g)
	}

	// Stage the second hunk only: it moves from the working diff to the
	// staged one.
	d := f.diff(t, "a.txt", "work")
	if len(d.Hunks) != 2 {
		t.Fatalf("hunks: %+v", d)
	}
	f.must(t, "hunk", map[string]any{"path": "a.txt", "side": "work", "action": "stage", "index": 1, "hash": d.Hunks[1]})
	if w, i := f.diff(t, "a.txt", "work"), f.diff(t, "a.txt", "index"); len(w.Hunks) != 1 || len(i.Hunks) != 1 || !strings.Contains(i.Diff, "+line 25 changed") || !strings.Contains(w.Diff, "+line 2 changed") {
		t.Errorf("after staging a hunk: work %s\nindex %s", w.Diff, i.Diff)
	}
	// The same hunk again, now stale: refused, nothing applied.
	if code, m := f.op(t, "hunk", map[string]any{"path": "a.txt", "side": "work", "action": "stage", "index": 1, "hash": d.Hunks[1]}); code != 409 {
		t.Errorf("a stale hunk: %d %v", code, m)
	}
	// A hash that matches nothing at a real index.
	if code, _ := f.op(t, "hunk", map[string]any{"path": "a.txt", "side": "work", "action": "stage", "index": 0, "hash": "0000000000000000"}); code != 409 {
		t.Errorf("a wrong hash: %d", code)
	}
	// Unstage it again.
	i := f.diff(t, "a.txt", "index")
	f.must(t, "hunk", map[string]any{"path": "a.txt", "side": "index", "action": "unstage", "index": 0, "hash": i.Hunks[0]})
	if i := f.diff(t, "a.txt", "index"); i.Diff != "" {
		t.Errorf("after unstaging: %s", i.Diff)
	}
	if code, _ := f.op(t, "hunk", map[string]any{"path": "a.txt", "side": "index", "action": "stage", "index": 0, "hash": "x"}); code != 400 {
		t.Errorf("staging from the staged side: %d", code)
	}

	// Discard the first hunk, then Undo.
	d = f.diff(t, "a.txt", "work")
	r := f.must(t, "hunk", map[string]any{"path": "a.txt", "side": "work", "action": "discard", "index": 0, "hash": d.Hunks[0]})
	if got := read(t, f.root, "a.txt"); strings.Contains(got, "line 2 changed") || !strings.Contains(got, "line 25 changed") {
		t.Errorf("after discarding a hunk: %s", got)
	}
	if code, out := post(t, f.base+"/api/git/restore", map[string]string{"trash": r["trash"].(string)}); code != 200 {
		t.Fatalf("restore the hunk: %d %s", code, out)
	}
	if read(t, f.root, "a.txt") != a {
		t.Errorf("the hunk is not back: %s", read(t, f.root, "a.txt"))
	}
	// The entry is used up.
	if code, _ := post(t, f.base+"/api/git/restore", map[string]string{"trash": r["trash"].(string)}); code != 404 {
		t.Errorf("a second Undo: %d", code)
	}

	// Discard whole files: a modified one and a new one, then Undo.
	r = f.must(t, "discard", map[string]any{"paths": []string{"a.txt", "c.txt"}})
	if read(t, f.root, "a.txt") != numbered(1, 30) {
		t.Errorf("a.txt not discarded")
	}
	if _, err := os.Stat(filepath.Join(f.root, "c.txt")); err == nil {
		t.Errorf("c.txt still there")
	}
	post(t, f.base+"/api/git/restore", map[string]string{"trash": r["trash"].(string)})
	if read(t, f.root, "a.txt") != a || read(t, f.root, "c.txt") != "one\ntwo\nthree" {
		t.Errorf("not restored")
	}
	// Undo never writes over later work.
	r = f.must(t, "discard", map[string]any{"paths": []string{"a.txt"}})
	write(t, f.root, "a.txt", "typed since\n")
	if code, _ := post(t, f.base+"/api/git/restore", map[string]string{"trash": r["trash"].(string)}); code != 409 || read(t, f.root, "a.txt") != "typed since\n" {
		t.Errorf("restore over a changed file: %d", code)
	}
	// A deleted file brought back, and deleted again by Undo. A new folder.
	os.Remove(filepath.Join(f.root, "x.txt"))
	write(t, f.root, "newdir/deep/n.txt", "n\n")
	r = f.must(t, "discard", map[string]any{"paths": []string{"x.txt", "newdir/"}})
	if read(t, f.root, "x.txt") != "shared\n" {
		t.Errorf("x.txt not back")
	}
	if _, err := os.Stat(filepath.Join(f.root, "newdir")); err == nil {
		t.Errorf("newdir still there")
	}
	post(t, f.base+"/api/git/restore", map[string]string{"trash": r["trash"].(string)})
	if _, err := os.Stat(filepath.Join(f.root, "x.txt")); err == nil || read(t, f.root, "newdir/deep/n.txt") != "n\n" {
		t.Errorf("undo of a brought back file and a folder")
	}
	gitOut(t, f.root, "checkout", "--", "x.txt")
	// A staged-only change has nothing to discard.
	if code, _ := f.op(t, "discard", map[string]any{"paths": []string{"b.txt"}}); code != 409 {
		t.Errorf("discard of a staged change: %d", code)
	}

	// Files: stage, unstage, all.
	f.must(t, "stage", map[string]any{"paths": []string{"c.txt", "newdir/"}})
	if _, m := f.status(t); m["c.txt"].X != "A" || m["newdir/deep/n.txt"].X != "A" {
		t.Errorf("staged: %+v", m)
	}
	f.must(t, "unstage", map[string]any{"paths": []string{"c.txt"}})
	if _, m := f.status(t); m["c.txt"].Y != "U" {
		t.Errorf("unstaged: %+v", m["c.txt"])
	}
	f.must(t, "stage", map[string]any{"all": true})
	if _, m := f.status(t); m["a.txt"].X != "M" || m["a.txt"].Y != "" || m["c.txt"].X != "A" {
		t.Errorf("stage all: %+v", m)
	}
	f.must(t, "unstage", map[string]any{"all": true})
	if _, m := f.status(t); m["b.txt"].X != "" || m["b.txt"].Y != "M" {
		t.Errorf("unstage all: %+v", m)
	}

	// Refused: paths out of the folder, into .git, a credentials file, a
	// folder not open, a repository the folder does not have.
	for _, p := range []string{"../x", "/etc/passwd", ".git/config", "sub/../../x", ".git-credentials"} {
		if code, _ := f.op(t, "stage", map[string]any{"paths": []string{p}}); code != 400 && code != 403 {
			t.Errorf("stage %s: %d", p, code)
		}
		if code, _ := f.op(t, "discard", map[string]any{"paths": []string{p}}); code != 400 && code != 403 {
			t.Errorf("discard %s: %d", p, code)
		}
	}
	if code, _ := f.op(t, "stage", map[string]any{"root": t.TempDir(), "paths": []string{"a.txt"}}); code != 403 {
		t.Errorf("a folder not open: %d", code)
	}
	if code, _ := f.op(t, "stage", map[string]any{"repo": "../other", "paths": []string{"a.txt"}}); code != 403 {
		t.Errorf("a repository not the folder's: %d", code)
	}
	if code, _ := post(t, f.base+"/api/git/restore", map[string]string{"trash": "../../etc"}); code != 400 {
		t.Errorf("a bad trash name: %d", code)
	}
	if resp, _ := fetch(t, f.base+"/api/git/diff?side=work&root="+url.QueryEscape(f.root)+"&path=..%2Fx", token); resp.StatusCode != 400 {
		t.Errorf("a diff out of the folder: %d", resp.StatusCode)
	}
}

// Commit, push, pull (with a conflict), sync, branches and a branch with
// no upstream.
func TestGitCommitPushPull(t *testing.T) {
	f := newGitFixture(t)
	if code, m := f.op(t, "commit", map[string]any{"message": "nothing"}); code != 409 || !strings.Contains(m["error"].(string), "nothing is staged") {
		t.Errorf("nothing staged: %d %v", code, m)
	}
	if code, _ := f.op(t, "commit", map[string]any{"message": "nothing", "all": true}); code != 409 {
		t.Errorf("nothing to commit: %d", code)
	}
	write(t, f.root, "b.txt", "bee\nmore\n")
	write(t, f.root, "new.txt", "new\n")
	if code, _ := f.op(t, "commit", map[string]any{"message": "  ", "all": true}); code != 400 {
		t.Errorf("no message: %d", code)
	}
	// With nothing staged, all stages everything first, new files too.
	m := f.must(t, "commit", map[string]any{"message": "Add more", "all": true})
	if len(m["head"].(string)) < 7 {
		t.Errorf("commit: %v", m)
	}
	if repo, files := f.status(t); repo.Ahead != 1 || len(files) != 0 {
		t.Errorf("after commit: %+v %v", repo, files)
	}
	if subj := gitOut(t, f.root, "log", "-1", "--format=%s"); subj != "Add more\n" {
		t.Errorf("subject: %q", subj)
	}
	f.must(t, "push", map[string]any{})
	if got := gitOut(t, f.bare, "log", "-1", "--format=%s", "main"); got != "Add more\n" {
		t.Errorf("the remote has %q", got)
	}

	// Commit and push in one.
	write(t, f.root, "b.txt", "bee\nmore\nagain\n")
	gitOut(t, f.root, "add", "b.txt")
	if m := f.must(t, "commit", map[string]any{"message": "Again", "push": true}); m["pushed"] != true {
		t.Errorf("commit and push: %v", m)
	}

	// Pull what another clone pushed.
	gitOut(t, f.other, "pull", "-q")
	write(t, f.other, "from-other.txt", "hi\n")
	gitOut(t, f.other, "add", ".")
	gitOut(t, f.other, "commit", "-q", "-m", "From the other clone")
	gitOut(t, f.other, "push", "-q")
	gitOut(t, f.root, "fetch", "-q")
	if repo, _ := f.status(t); repo.Behind != 1 {
		t.Errorf("behind: %+v", repo)
	}
	f.must(t, "pull", map[string]any{})
	if read(t, f.root, "from-other.txt") != "hi\n" {
		t.Errorf("not pulled")
	}

	// Sync: pull, then push a local commit.
	write(t, f.root, "local.txt", "l\n")
	f.must(t, "commit", map[string]any{"message": "Local", "all": true})
	f.must(t, "sync", map[string]any{})
	if got := gitOut(t, f.bare, "log", "-1", "--format=%s", "main"); got != "Local\n" {
		t.Errorf("after sync the remote has %q", got)
	}

	// A pull that conflicts says so, in git's words, and leaves the files
	// marked as conflicts.
	gitOut(t, f.other, "pull", "-q")
	write(t, f.other, "x.txt", "theirs\n")
	gitOut(t, f.other, "commit", "-q", "-am", "Theirs")
	gitOut(t, f.other, "push", "-q")
	write(t, f.root, "x.txt", "ours\n")
	f.must(t, "commit", map[string]any{"message": "Ours", "all": true})
	code, m := f.op(t, "pull", map[string]any{})
	if code != 409 || !strings.Contains(strings.ToLower(m["error"].(string)), "conflict") {
		t.Errorf("a conflicting pull: %d %v", code, m)
	}
	if _, files := f.status(t); files["x.txt"].St != "C" || files["x.txt"].Y != "C" {
		t.Errorf("conflict mark: %+v", files)
	}
	gitOut(t, f.root, "merge", "--abort")

	// Branches: a new one from HEAD has no upstream, so a pull is refused
	// and a push publishes it.
	f.must(t, "branch", map[string]any{"name": "feature"})
	if code, _ := f.op(t, "branch", map[string]any{"name": "-x"}); code != 400 {
		t.Errorf("a bad branch name: %d", code)
	}
	if code, _ := f.op(t, "branch", map[string]any{"name": "a..b"}); code != 400 {
		t.Errorf("a bad branch name: %d", code)
	}
	repo, _ := f.status(t)
	if repo.Branch != "feature" || repo.Upstream != "" || !repo.Remote {
		t.Errorf("new branch: %+v", repo)
	}
	if code, m := f.op(t, "pull", map[string]any{}); code != 409 || !strings.Contains(m["error"].(string), "no upstream") {
		t.Errorf("pull with no upstream: %d %v", code, m)
	}
	f.must(t, "push", map[string]any{})
	if repo, _ := f.status(t); repo.Upstream != "origin/feature" {
		t.Errorf("published: %+v", repo)
	}
	resp, body := fetch(t, f.base+"/api/git/branches?root="+url.QueryEscape(f.root), token)
	var br struct {
		Branches []struct {
			Name, Upstream string
			Current        bool
		}
	}
	json.Unmarshal(body, &br)
	if resp.StatusCode != 200 || len(br.Branches) != 2 {
		t.Errorf("branches: %s", body)
	}
	f.must(t, "switch", map[string]any{"branch": "main"})
	if code, _ := f.op(t, "switch", map[string]any{"branch": "--orphan"}); code != 404 {
		t.Errorf("switch to an option: %d", code)
	}
	if repo, _ := f.status(t); repo.Branch != "main" {
		t.Errorf("switched: %+v", repo)
	}

	// A repository with no remote at all.
	lone := t.TempDir()
	gitOut(t, lone, "init", "-q", "-b", "main")
	write(t, lone, "l.txt", "l\n")
	post(t, f.base+"/api/folders/open", map[string]string{"path": lone})
	if code, m := f.op(t, "commit", map[string]any{"root": lone, "message": "First", "all": true, "push": true}); code != 200 || m["pushError"] == nil {
		t.Errorf("commit and push with no remote: %d %v", code, m)
	}
	if code, _ := f.op(t, "push", map[string]any{"root": lone}); code != 409 {
		t.Errorf("push with no remote: %d", code)
	}
}

// The history, paged, with what is not pushed. Revert. Check out, its
// detached HEAD, and back to the branch.
func TestGitHistory(t *testing.T) {
	f := newGitFixture(t)
	for i := 0; i < 34; i++ {
		write(t, f.root, "count.txt", strings.Repeat("x", i+1)+"\n")
		gitOut(t, f.root, "add", ".")
		gitOut(t, f.root, "commit", "-q", "-m", "Step "+string(rune('A'+i%26)))
	}
	type logRes struct {
		Commits []struct {
			Sha, Short, Subject string
			Refs                []string
			Out, Here           bool
		}
		More bool
	}
	logAt := func(skip string) logRes {
		t.Helper()
		resp, body := fetch(t, f.base+"/api/git/log?root="+url.QueryEscape(f.root)+"&skip="+skip, token)
		if resp.StatusCode != 200 {
			t.Fatalf("log: %d %s", resp.StatusCode, body)
		}
		var l logRes
		json.Unmarshal(body, &l)
		return l
	}
	l := logAt("0")
	if len(l.Commits) != 30 || !l.More || !l.Commits[0].Out || !l.Commits[0].Here || l.Commits[0].Subject != "Step H" {
		t.Fatalf("first page: %+v", l)
	}
	l2 := logAt("30")
	// 34 new and the first: 35 in all. The first is pushed and carries
	// the remote's branch.
	if len(l2.Commits) != 5 || l2.More || l2.Commits[4].Out || l2.Commits[4].Subject != "first" || len(l2.Commits[4].Refs) != 1 || l2.Commits[4].Refs[0] != "origin/main" {
		t.Errorf("second page: %+v", l2)
	}

	// Revert a commit: a new one undoing it.
	write(t, f.root, "r.txt", "to revert\n")
	gitOut(t, f.root, "add", ".")
	gitOut(t, f.root, "commit", "-q", "-m", "Add r")
	sha := strings.TrimSpace(gitOut(t, f.root, "rev-parse", "--short", "HEAD"))
	f.must(t, "revert", map[string]any{"sha": sha})
	if _, err := os.Stat(filepath.Join(f.root, "r.txt")); err == nil {
		t.Errorf("not reverted")
	}
	if subj := gitOut(t, f.root, "log", "-1", "--format=%s"); !strings.HasPrefix(subj, "Revert") {
		t.Errorf("revert commit: %q", subj)
	}
	for _, bad := range []string{"--abort", "HEAD~1", "zzzzzzz", ""} {
		if code, _ := f.op(t, "revert", map[string]any{"sha": bad}); code != 400 {
			t.Errorf("revert %q: %d", bad, code)
		}
	}
	if code, _ := f.op(t, "revert", map[string]any{"sha": "abcdef1"}); code != 404 {
		t.Errorf("revert of no commit: %d", code)
	}
	// A revert that would conflict changes nothing.
	write(t, f.root, "count.txt", "rewritten\n")
	gitOut(t, f.root, "commit", "-q", "-am", "Rewrite")
	before := gitOut(t, f.root, "rev-parse", "HEAD")
	if code, m := f.op(t, "revert", map[string]any{"sha": l.Commits[3].Sha}); code != 409 || !strings.Contains(m["error"].(string), "nothing was changed") {
		t.Errorf("a conflicting revert: %d %v", code, m)
	}
	if gitOut(t, f.root, "rev-parse", "HEAD") != before || gitOut(t, f.root, "status", "--porcelain") != "" {
		t.Errorf("a conflicting revert left something")
	}

	// Check out an older commit: detached, the branch to go back to known,
	// the branch's newer commits still in the history.
	old := l.Commits[5]
	f.must(t, "checkout", map[string]any{"sha": old.Short})
	repo, _ := f.status(t)
	if !repo.Detached || repo.Branch != "" || repo.Back != "main" || repo.Head != old.Short[:7] {
		t.Errorf("detached: %+v", repo)
	}
	l = logAt("0")
	here := ""
	for _, c := range l.Commits {
		if c.Here {
			here = c.Sha
		}
	}
	if here != old.Sha || l.Commits[0].Subject != "Rewrite" {
		t.Errorf("history while detached: here %s, first %+v", here, l.Commits[0])
	}
	if code, m := f.op(t, "push", map[string]any{}); code != 409 || !strings.Contains(m["error"].(string), "not on a branch") {
		t.Errorf("push while detached: %d %v", code, m)
	}
	if code, _ := f.op(t, "pull", map[string]any{}); code != 409 {
		t.Errorf("pull while detached: %d", code)
	}
	f.must(t, "switch", map[string]any{"branch": repo.Back})
	if repo, _ := f.status(t); repo.Detached || repo.Branch != "main" {
		t.Errorf("back: %+v", repo)
	}
}

// Several repositories in one folder: each acts on its own files only.
func TestGitOpsManyRepos(t *testing.T) {
	f := newGitFixture(t)
	plain := t.TempDir()
	for _, name := range []string{"one", "two"} {
		d := filepath.Join(plain, name)
		os.MkdirAll(d, 0o755)
		gitOut(t, d, "init", "-q", "-b", "main")
		write(t, d, "x.txt", name+"\n")
	}
	post(t, f.base+"/api/folders/open", map[string]string{"path": plain})
	if code, _ := f.op(t, "stage", map[string]any{"root": plain, "repo": "one", "paths": []string{"one/x.txt"}}); code != 200 {
		t.Errorf("stage in one: %d", code)
	}
	if code, _ := f.op(t, "stage", map[string]any{"root": plain, "repo": "one", "paths": []string{"two/x.txt"}}); code != 403 {
		t.Errorf("a path of two staged through one: %d", code)
	}
	if code, _ := f.op(t, "stage", map[string]any{"root": plain, "repo": "", "paths": []string{"one/x.txt"}}); code != 404 {
		t.Errorf("the folder itself is no repository: %d", code)
	}
	if code, m := f.op(t, "commit", map[string]any{"root": plain, "repo": "one", "message": "One"}); code != 200 {
		t.Errorf("commit in one: %d %v", code, m)
	}
	if got := gitOut(t, filepath.Join(plain, "one"), "log", "--format=%s"); got != "One\n" {
		t.Errorf("one's log: %q", got)
	}
	if out := gitOut(t, filepath.Join(plain, "two"), "status", "--porcelain"); out != "?? x.txt\n" {
		t.Errorf("two touched: %q", out)
	}
	// A repository inside the folder's own: its file belongs to it.
	inner := filepath.Join(f.root, "inner")
	os.MkdirAll(inner, 0o755)
	gitOut(t, inner, "init", "-q", "-b", "main")
	write(t, inner, "i.txt", "i\n")
	f2 := newGitFixture(t) // a fresh server, so the inner repository is found
	f2.root = f.root
	post(t, f2.base+"/api/folders/open", map[string]string{"path": f.root})
	if code, _ := f2.op(t, "stage", map[string]any{"paths": []string{"inner/i.txt"}}); code != 403 {
		t.Errorf("the inner repository's file through the outer: %d", code)
	}
	if code, _ := f2.op(t, "stage", map[string]any{"repo": "inner", "paths": []string{"inner/i.txt"}}); code != 200 {
		t.Errorf("stage in the inner repository: %d", code)
	}
}
