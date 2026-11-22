package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// What git says about a project's folder, read only: the branches, and the
// files changed since the last commit with the diff of each. It runs the
// git on the PATH, as one would in a terminal; no git, or no repository
// anywhere, is simply no repository.
//
//	GET /api/git?root=R              {repo, branch, ahead, behind, repos: [{path, branch, ...}], files: [{path, st, repo}]}
//	GET /api/git/diff?root=R&path=P  {diff, cut}: the change to P since HEAD, as a unified diff
//
// Every repository in the project speaks for its own files: the one the
// folder is in (at "", its changes under the folder only), and any found
// in folders below it, a project of several repositories or one inside
// another. A file belongs to the innermost. Paths are relative to R, with
// forward slashes; an untracked folder is one entry ending in a slash. st
// is M, A, D, R, U (untracked) or C (a merge conflict).

const (
	gitTimeout = 10 * time.Second
	maxDiff    = 2 << 20
	// Repositories below the folder are looked for this deep, in at most
	// this many folders, and looked for again after a minute.
	repoDepth  = 5
	repoDirs   = 5000
	maxRepos   = 30
	reposFresh = time.Minute
)

type gitFile struct {
	Path string `json:"path"`
	St   string `json:"st"`
	Repo string `json:"repo"`
}

type gitRepo struct {
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
	Ahead  int    `json:"ahead,omitempty"`
	Behind int    `json:"behind,omitempty"`
}

type gitState struct {
	Repo   bool      `json:"repo"`
	Branch string    `json:"branch,omitempty"` // the folder's own repository's
	Ahead  int       `json:"ahead,omitempty"`
	Behind int       `json:"behind,omitempty"`
	Repos  []gitRepo `json:"repos"`
	Files  []gitFile `json:"files"`
}

// git runs one git command in dir. Optional locks are off, so a status
// here never holds the index while an agent commits; an fsmonitor hook
// or an external diff tool named in the repo's config is not run.
func git(ctx context.Context, dir string, limit int64, args ...string) ([]byte, error) {
	bin, err := exec.LookPath("git")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, append([]string{"-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "--literal-pathspecs", "--no-pager"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	hideWindow(cmd)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	b, _ := io.ReadAll(io.LimitReader(out, limit))
	io.Copy(io.Discard, out)
	return b, cmd.Wait()
}

// Folders not searched for repositories: what package managers and
// builds fill, where nobody keeps one.
var noRepoSearch = map[string]bool{"node_modules": true, "vendor": true, "__pycache__": true, "venv": true, "target": true, "build": true, "dist": true}

type repoCache struct {
	sync.Mutex
	m map[string]repoList
}

type repoList struct {
	at    time.Time
	paths []string
}

// reposBelow lists the repositories in folders below root (not root
// itself), relative to it with forward slashes, kept for a minute.
func (rc *repoCache) reposBelow(root string) []string {
	rc.Lock()
	c, ok := rc.m[root]
	rc.Unlock()
	if ok && time.Since(c.at) < reposFresh {
		return c.paths
	}
	var found []string
	seen := 0
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if p == root {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") || noRepoSearch[strings.ToLower(name)] || secretNames[strings.ToLower(name)] {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(root, p)
		if strings.Count(rel, string(filepath.Separator)) >= repoDepth {
			return filepath.SkipDir
		}
		if seen++; seen > repoDirs || len(found) >= maxRepos {
			return filepath.SkipAll
		}
		// A .git folder, or a .git file (a worktree or a submodule).
		if _, err := os.Lstat(filepath.Join(p, ".git")); err == nil {
			found = append(found, filepath.ToSlash(rel))
		}
		return nil
	})
	rc.Lock()
	if rc.m == nil {
		rc.m = map[string]repoList{}
	}
	rc.m[root] = repoList{time.Now(), found}
	rc.Unlock()
	return found
}

func (s *Server) gitStatus(w http.ResponseWriter, r *http.Request) {
	root, err := s.fileRoot(r.URL.Query().Get("root"))
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	writeJSON(w, readGit(r.Context(), root, s.repos.reposBelow(root)))
}

func readGit(ctx context.Context, root string, below []string) gitState {
	st := gitState{Repos: []gitRepo{}, Files: []gitFile{}}
	// The folder's own repository, its changes under the folder only.
	if prefix, err := git(ctx, root, 1<<12, "rev-parse", "--show-prefix"); err == nil {
		if out, err := git(ctx, root, 16<<20, "status", "--porcelain=v2", "--branch", "-z", "--", "."); err == nil {
			repo := gitRepo{}
			parseStatus(&repo, &st.Files, out, strings.TrimSpace(string(prefix)), "")
			st.Repos = append(st.Repos, repo)
			st.Branch, st.Ahead, st.Behind = repo.Branch, repo.Ahead, repo.Behind
		}
	}
	for _, sub := range below {
		out, err := git(ctx, filepath.Join(root, filepath.FromSlash(sub)), 16<<20, "status", "--porcelain=v2", "--branch", "-z")
		if err != nil {
			continue
		}
		repo := gitRepo{Path: sub}
		parseStatus(&repo, &st.Files, out, "", sub)
		st.Repos = append(st.Repos, repo)
	}
	st.Repo = len(st.Repos) > 0
	return st
}

// parseStatus reads `git status --porcelain=v2 --branch -z`, whose paths
// are relative to the top of the repository; prefix is the folder's place
// below the top ("sub/dir/"), repo the repository's place in the folder.
func parseStatus(repo *gitRepo, files *[]gitFile, out []byte, prefix, at string) {
	recs := strings.Split(string(out), "\x00")
	for i := 0; i < len(recs); i++ {
		rec := recs[i]
		if rec == "" {
			continue
		}
		var path, code string
		switch rec[0] {
		case '#':
			f := strings.Fields(rec)
			if len(f) >= 3 && f[1] == "branch.head" && f[2] != "(detached)" {
				repo.Branch = f[2]
			}
			if len(f) >= 4 && f[1] == "branch.ab" {
				repo.Ahead, _ = strconv.Atoi(strings.TrimPrefix(f[2], "+"))
				repo.Behind, _ = strconv.Atoi(strings.TrimPrefix(f[3], "-"))
			}
			continue
		case '1':
			f := strings.SplitN(rec, " ", 9)
			if len(f) < 9 {
				continue
			}
			code, path = f[1], f[8]
		case '2':
			f := strings.SplitN(rec, " ", 10)
			if len(f) < 10 {
				continue
			}
			code, path = "R", f[9]
			i++ // the original path follows as its own field
		case 'u':
			f := strings.SplitN(rec, " ", 11)
			if len(f) < 11 {
				continue
			}
			code, path = "C", f[10]
		case '?':
			code, path = "U", rec[2:]
		default:
			continue
		}
		if !strings.HasPrefix(path, prefix) {
			continue
		}
		path = path[len(prefix):]
		if at != "" {
			path = at + "/" + path
		}
		*files = append(*files, gitFile{Path: path, St: letter(code), Repo: at})
	}
}

// letter is the one mark VS Code shows for a change.
func letter(xy string) string {
	switch {
	case len(xy) == 1:
		return xy
	case strings.ContainsRune(xy, 'D'):
		return "D"
	case strings.ContainsRune(xy, 'A'):
		return "A"
	case strings.ContainsRune(xy, 'R'):
		return "R"
	}
	return "M"
}

// gitDiff runs in the file's own folder (the nearest one still there, for
// a deleted file), so git picks the innermost repository holding it.
func (s *Server) gitDiff(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	root, err := s.fileRoot(q.Get("root"))
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	rel, err := relPath(q.Get("path"))
	if err != nil || rel == "." {
		s.reply(w, http.StatusOK)(nil, badPath("bad path"))
		return
	}
	dir, name := filepath.Dir(rel), filepath.Base(rel)
	for dir != "." {
		if fi, err := os.Stat(filepath.Join(root, dir)); err == nil && fi.IsDir() {
			break
		}
		name = filepath.Join(filepath.Base(dir), name)
		dir = filepath.Dir(dir)
	}
	at := filepath.Join(root, dir)
	name = filepath.ToSlash(name)
	ctx := r.Context()
	if _, err := git(ctx, at, 1<<12, "rev-parse", "--show-prefix"); err != nil {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 404, msg: "not in a git repository"})
		return
	}
	common := []string{"--no-color", "--no-ext-diff", "--no-textconv"}
	var out []byte
	tracked, _ := git(ctx, at, 1<<12, "ls-files", "--", name)
	if len(bytes.TrimSpace(tracked)) == 0 {
		// Untracked: the whole file is new. diff --no-index says 1 when the
		// two differ, which they always do here.
		out, err = git(ctx, at, maxDiff+1, append(append([]string{"diff", "--no-index"}, common...), "--", "/dev/null", name)...)
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			err = nil
		}
	} else {
		base := "HEAD"
		if _, e := git(ctx, at, 1<<12, "rev-parse", "--verify", "-q", "HEAD"); e != nil {
			// No commit yet: compare with the empty tree.
			t, e := git(ctx, at, 1<<12, "hash-object", "-t", "tree", "/dev/null")
			if e != nil {
				s.reply(w, http.StatusOK)(nil, e)
				return
			}
			base = strings.TrimSpace(string(t))
		}
		out, err = git(ctx, at, maxDiff+1, append(append([]string{"diff"}, common...), base, "--", name)...)
	}
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	cut := len(out) > maxDiff
	if cut {
		out = out[:maxDiff]
	}
	writeJSON(w, struct {
		Diff string `json:"diff"`
		Cut  bool   `json:"cut,omitempty"`
	}{string(out), cut})
}
