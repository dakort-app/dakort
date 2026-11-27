package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Source control as VS Code's panel has it, on top of the read-only view
// in git.go: stage, unstage and discard (a file or one hunk of it),
// commit, pull and push, branches, the history, and going back to a
// commit. Each runs git with an argument list, never a shell line, in a
// repository the project's folder holds (its own, or one git.go found
// below it), with the same settings as the status: optional locks off, no
// fsmonitor hook, no external diff. Paths are relative to the folder, as
// /api/git names them. One outside it, inside .git, or held by another
// repository is refused.
//
//	POST /api/git/stage      {root, repo, paths | all}
//	POST /api/git/unstage    {root, repo, paths | all}
//	POST /api/git/discard    {root, repo, paths}                          {trash}
//	POST /api/git/hunk       {root, repo, path, side, action, index, hash}  {trash} for a discard
//	POST /api/git/restore    {trash}: Undo of a discard
//	POST /api/git/commit     {root, repo, message, all, push}             {head, pushError}
//	POST /api/git/pull, push, sync   {root, repo}
//	GET  /api/git/branches?root=R&repo=P                                  {branches: [{name, upstream, current}]}
//	POST /api/git/switch     {root, repo, branch}
//	POST /api/git/branch     {root, repo, name}: a new branch from HEAD, checked out
//	GET  /api/git/log?root=R&repo=P&skip=N                                {commits, more}
//	POST /api/git/revert     {root, repo, sha}: a new commit undoing it
//	POST /api/git/checkout   {root, repo, sha}: the commit itself, no branch
//
// A discard keeps what it destroys in the app's trash (a working file's
// content, an untracked file or folder, a hunk's patch), so Undo puts it
// back. Trash.go empties old entries.
//
// A hunk is named by its place in the diff and a hash of its header and
// lines, both as /api/git/diff gave them. The server works the diff out
// again and refuses when that hunk is no longer there: the patch it
// applies is always cut from git's own diff, never from the client.

const (
	gitWriteTimeout = 60 * time.Second // a commit runs the repository's hooks
	gitNetTimeout   = 90 * time.Second
	logPage         = 30
)

// Every git trash entry is named like this. Nothing else is ever moved out
// of the trash or removed from it here.
var gitTrashName = regexp.MustCompile(`^made-gittrash-[0-9]+-[0-9a-f]{16}$`)

var shaLike = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)

// One write at a time per repository: two at once would trip over git's
// index lock.
var gitLocks sync.Map

type gitRunOpts struct {
	stdin   []byte
	timeout time.Duration
	net     bool // may reach a remote: never prompt, longer timeout
}

// runGit runs one git command in dir and returns its output. A failure
// carries git's own message.
func runGit(ctx context.Context, dir string, o gitRunOpts, args ...string) (string, error) {
	bin, err := exec.LookPath("git")
	if err != nil {
		return "", &httpError{status: 501, msg: "git is not installed on this computer"}
	}
	if o.timeout == 0 {
		o.timeout = gitWriteTimeout
		if o.net {
			o.timeout = gitNetTimeout
		}
	}
	ctx, cancel := context.WithTimeout(ctx, o.timeout)
	defer cancel()
	full := append([]string{"-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-c", "color.ui=false", "--literal-pathspecs", "--no-pager"}, args...)
	cmd := exec.CommandContext(ctx, bin, full...)
	cmd.Dir = dir
	env := append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never", "GIT_EDITOR=true", "GIT_MERGE_AUTOEDIT=no")
	if o.net && os.Getenv("GIT_SSH_COMMAND") == "" && os.Getenv("GIT_SSH") == "" {
		// ssh asks nothing either, unless the repository names its own ssh.
		if own, _ := git(ctx, dir, 1<<12, "config", "--get", "core.sshCommand"); len(bytes.TrimSpace(own)) == 0 {
			env = append(env, "GIT_SSH_COMMAND=ssh -o BatchMode=yes")
		}
	}
	cmd.Env = env
	if o.stdin != nil {
		cmd.Stdin = bytes.NewReader(o.stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	cmd.WaitDelay = 2 * time.Second // an ssh left holding the pipes
	hideWindow(cmd)
	err = cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return out.String(), &httpError{status: 504, msg: "git " + args[0] + " took longer than " + strconv.Itoa(int(o.timeout/time.Second)) + " s and was stopped"}
	}
	if err != nil {
		return out.String(), &httpError{status: 409, msg: gitSays(errb.String(), out.String())}
	}
	return out.String(), nil
}

// gitSays is the part of git's output worth showing: its errors without
// the hints or the fetch's list of refs, then the conflicts a merge
// reports on stdout. Or, when it wrote neither, the end of what it printed.
func gitSays(stderr, stdout string) string {
	pick := func(s string, keep func(string) bool) []string {
		var out []string
		for _, l := range strings.Split(s, "\n") {
			if l = strings.TrimSpace(l); l != "" && keep(l) {
				out = append(out, l)
			}
		}
		return out
	}
	lines := pick(stderr, func(l string) bool {
		return !strings.HasPrefix(l, "hint:") && !strings.HasPrefix(l, "From ") && !strings.Contains(l, " -> ")
	})
	lines = append(lines, pick(stdout, func(l string) bool { return strings.Contains(strings.ToLower(l), "conflict") })...)
	if len(lines) == 0 {
		lines = pick(stdout, func(string) bool { return true })
	}
	if len(lines) > 6 {
		lines = lines[len(lines)-6:]
	}
	if len(lines) == 0 {
		return "git failed and said nothing"
	}
	return strings.Join(lines, "\n")
}

// repoAt is one repository of a project's folder.
type repoAt struct {
	root   string   // the folder, canonical
	repo   string   // the repository's place in it, "" for the folder's own
	dir    string   // root joined with repo
	top    string   // the top of its working tree
	prefix string   // dir's place below top: "" or ending in "/"
	below  []string // the repositories found below root
}

func (s *Server) repoAt(ctx context.Context, root, repo string) (*repoAt, error) {
	root, err := s.fileRoot(root)
	if err != nil {
		return nil, err
	}
	ra := &repoAt{root: root, repo: repo, dir: root, below: s.repos.reposBelow(root)}
	if repo != "" {
		known := false
		for _, b := range ra.below {
			known = known || b == repo
		}
		if !known {
			return nil, forbidden("that is not a repository of this folder")
		}
		ra.dir = filepath.Join(root, filepath.FromSlash(repo))
	}
	top, err := git(ctx, ra.dir, 1<<12, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, &httpError{status: 404, msg: "not in a git repository"}
	}
	prefix, err := git(ctx, ra.dir, 1<<12, "rev-parse", "--show-prefix")
	if err != nil {
		return nil, &httpError{status: 404, msg: "not in a git repository"}
	}
	ra.top = filepath.FromSlash(strings.TrimSpace(string(top)))
	ra.prefix = strings.TrimSpace(string(prefix))
	return ra, nil
}

// path turns a path as /api/git lists it into the same path from the top
// of the working tree (for git) and from the folder (for the trash).
func (ra *repoAt) path(p string) (top, inRoot string, err error) {
	rel, err := relPath(strings.TrimSuffix(p, "/"))
	if err != nil {
		return "", "", err
	}
	if rel == "." || insideGit(rel) {
		return "", "", badPath("bad path")
	}
	rel = filepath.ToSlash(rel)
	owner := ""
	for _, b := range ra.below {
		if (rel == b || strings.HasPrefix(rel, b+"/")) && len(b) > len(owner) {
			owner = b
		}
	}
	if owner != ra.repo || rel == ra.repo {
		return "", "", forbidden(p + " is not in that repository")
	}
	in := rel
	if ra.repo != "" {
		in = strings.TrimPrefix(rel, ra.repo+"/")
	}
	return ra.prefix + in, rel, nil
}

func (ra *repoAt) run(ctx context.Context, o gitRunOpts, args ...string) (string, error) {
	return runGit(ctx, ra.top, o, args...)
}

// ok says whether a git question answers yes (exit 0).
func (ra *repoAt) ok(ctx context.Context, args ...string) bool {
	_, err := git(ctx, ra.top, 1<<12, args...)
	return err == nil
}

func (ra *repoAt) hasHead(ctx context.Context) bool {
	return ra.ok(ctx, "rev-parse", "--verify", "-q", "HEAD")
}

type gitReq struct {
	Root    string   `json:"root"`
	Repo    string   `json:"repo"`
	Paths   []string `json:"paths"`
	All     bool     `json:"all"`
	Path    string   `json:"path"`
	Side    string   `json:"side"`   // a hunk's diff: "work" (not staged) or "index" (staged)
	Action  string   `json:"action"` // a hunk's: stage, unstage or discard
	Index   int      `json:"index"`
	Hash    string   `json:"hash"`
	Message string   `json:"message"`
	Push    bool     `json:"push"`
	Branch  string   `json:"branch"`
	Name    string   `json:"name"`
	Sha     string   `json:"sha"`
}

type gitOp func(ctx context.Context, ra *repoAt, q gitReq) (any, error)

// gitPost reads the request, finds the repository and runs op with the
// repository's lock held.
func (s *Server) gitPost(op gitOp) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var q gitReq
		if !readJSON(w, r, &q) {
			return
		}
		done := s.reply(w, http.StatusOK)
		ra, err := s.repoAt(r.Context(), q.Root, q.Repo)
		if err != nil {
			done(nil, err)
			return
		}
		mu, _ := gitLocks.LoadOrStore(ra.top, &sync.Mutex{})
		mu.(*sync.Mutex).Lock()
		defer mu.(*sync.Mutex).Unlock()
		v, err := op(r.Context(), ra, q)
		if v == nil {
			v = struct{}{}
		}
		done(v, err)
	}
}

// paths maps the request's paths, refusing all of them if one is bad.
func (ra *repoAt) paths(ps []string) ([]string, error) {
	if len(ps) == 0 {
		return nil, badPath("no paths")
	}
	var out []string
	for _, p := range ps {
		t, _, err := ra.path(p)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

func gitStage(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	if q.All {
		_, err := runGit(ctx, ra.dir, gitRunOpts{}, "add", "-A", "--", ".")
		return nil, err
	}
	ps, err := ra.paths(q.Paths)
	if err != nil {
		return nil, err
	}
	_, err = ra.run(ctx, gitRunOpts{}, append([]string{"add", "-A", "--"}, ps...)...)
	return nil, err
}

func gitUnstage(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	dir, ps := ra.top, []string{}
	if q.All {
		dir, ps = ra.dir, []string{"."}
	} else {
		var err error
		if ps, err = ra.paths(q.Paths); err != nil {
			return nil, err
		}
	}
	// Before the first commit there is no HEAD to take the index back to:
	// the files leave the index, staying on disk.
	args := []string{"restore", "--staged", "--"}
	if !ra.hasHead(ctx) {
		args = []string{"rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"}
	}
	_, err := runGit(ctx, dir, gitRunOpts{}, append(args, ps...)...)
	return nil, err
}

// ---- Discard and its trash ----

type gitTrashMeta struct {
	Root    string         `json:"root"`
	Repo    string         `json:"repo"`
	Deleted time.Time      `json:"deleted"`
	Items   []gitTrashItem `json:"items"`
}

// gitTrashItem is one thing a discard destroyed, kept in the entry as
// items/<n>. Kind "file": a tracked file's working content (Had says it
// existed, and a deleted file brought back had none), After the hash of what
// the discard left there, so Undo never writes over later work. Kind
// "new": an untracked file or folder, moved in whole. Kind "patch": a
// hunk, as the patch whose reverse was applied.
type gitTrashItem struct {
	Path  string `json:"path"` // inside Root, with forward slashes
	Kind  string `json:"kind"`
	Had   bool   `json:"had,omitempty"`
	After string `json:"after,omitempty"`
}

type gitTrash struct {
	dir  string
	name string
	meta gitTrashMeta
}

func (s *Server) newGitTrash(ra *repoAt) (*gitTrash, error) {
	if s.trash == "" {
		return nil, &httpError{status: 503, msg: "this server has no trash, so it discards nothing"}
	}
	var rnd [8]byte
	rand.Read(rnd[:])
	name := "made-gittrash-" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "-" + hex.EncodeToString(rnd[:])
	dir := filepath.Join(s.trash, name)
	if err := os.MkdirAll(filepath.Join(dir, "items"), 0o700); err != nil {
		return nil, err
	}
	return &gitTrash{dir: dir, name: name, meta: gitTrashMeta{Root: ra.root, Repo: ra.repo, Deleted: time.Now()}}, nil
}

func (t *gitTrash) item(n int) string { return filepath.Join(t.dir, "items", strconv.Itoa(n)) }

func (t *gitTrash) save() error {
	b, _ := json.Marshal(t.meta)
	return os.WriteFile(filepath.Join(t.dir, "meta.json"), b, 0o600)
}

// drop removes an entry this call made and filled, file by file.
func (t *gitTrash) drop() {
	for i := range t.meta.Items {
		os.Remove(t.item(i))
	}
	os.Remove(filepath.Join(t.dir, "meta.json"))
	os.Remove(filepath.Join(t.dir, "items"))
	os.Remove(t.dir)
}

// hashAt is the sha256 of a file inside root, "" when there is none.
func hashAt(root, rel string) string {
	rt, err := os.OpenRoot(root)
	if err != nil {
		return ""
	}
	defer rt.Close()
	f, err := rt.Open(filepath.FromSlash(rel))
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (s *Server) gitDiscard(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	if len(q.Paths) == 0 {
		return nil, badPath("no paths")
	}
	type one struct{ top, in string }
	var list []one
	for _, p := range q.Paths {
		t, in, err := ra.path(p)
		if err != nil {
			return nil, err
		}
		list = append(list, one{t, in})
	}
	rt, err := os.OpenRoot(ra.root)
	if err != nil {
		return nil, &httpError{status: 404, msg: "folder not found"}
	}
	defer rt.Close()
	tr, err := s.newGitTrash(ra)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (any, error) {
		if len(tr.meta.Items) > 0 {
			// Some went already: keep them restorable.
			tr.save()
			return map[string]string{"trash": tr.name, "error": err.Error()}, nil
		}
		tr.drop()
		return nil, err
	}
	for _, f := range list {
		inIndex, _ := ra.run(ctx, gitRunOpts{}, "ls-files", "--", f.top)
		n := len(tr.meta.Items)
		if strings.TrimSpace(inIndex) == "" {
			// Untracked: the file or folder goes to the trash whole, if
			// git would list it (not ignored).
			others, _ := ra.run(ctx, gitRunOpts{}, "ls-files", "--others", "--exclude-standard", "--", f.top)
			if strings.TrimSpace(others) == "" {
				return fail(badPath(f.in + " has no changes to discard"))
			}
			fi, err := rt.Lstat(filepath.FromSlash(f.in))
			if err != nil || (!fi.Mode().IsRegular() && !fi.IsDir()) {
				return fail(badPath("cannot reach " + f.in))
			}
			from := filepath.Join(ra.root, filepath.FromSlash(f.in))
			if fi.IsDir() {
				err = os.Rename(from, tr.item(n))
			} else {
				err = moveFile(from, tr.item(n))
			}
			if err != nil {
				return fail(&httpError{status: 409, msg: "could not move " + f.in + " to the trash (is it open in another program?)"})
			}
			tr.meta.Items = append(tr.meta.Items, gitTrashItem{Path: f.in, Kind: "new"})
			continue
		}
		if ra.ok(ctx, "diff", "--quiet", "--no-ext-diff", "--", f.top) {
			continue // nothing in the working tree to discard (staged only)
		}
		item := gitTrashItem{Path: f.in, Kind: "file"}
		if fi, err := rt.Lstat(filepath.FromSlash(f.in)); err == nil {
			if !fi.Mode().IsRegular() {
				return fail(badPath(f.in + " is not a plain file; discard it from a terminal"))
			}
			src, err := rt.Open(filepath.FromSlash(f.in))
			if err != nil {
				return fail(badPath("cannot read " + f.in))
			}
			dst, err := os.OpenFile(tr.item(n), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err == nil {
				_, err = io.Copy(dst, src)
				if cerr := dst.Close(); err == nil {
					err = cerr
				}
			}
			src.Close()
			if err != nil {
				os.Remove(tr.item(n))
				return fail(err)
			}
			item.Had = true
		} else if !errors.Is(err, fs.ErrNotExist) {
			return fail(badPath("cannot reach " + f.in))
		}
		if _, err := ra.run(ctx, gitRunOpts{}, "restore", "--worktree", "--", f.top); err != nil {
			os.Remove(tr.item(n))
			return fail(err)
		}
		item.After = hashAt(ra.root, f.in)
		tr.meta.Items = append(tr.meta.Items, item)
	}
	if len(tr.meta.Items) == 0 {
		tr.drop()
		return nil, &httpError{status: 409, msg: "nothing to discard: the changes are staged"}
	}
	if err := tr.save(); err != nil {
		return nil, err
	}
	return map[string]string{"trash": tr.name}, nil
}

func (s *Server) gitRestore(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Trash string `json:"trash"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	done := s.reply(w, http.StatusOK)
	if !gitTrashName.MatchString(req.Trash) || s.trash == "" {
		done(nil, badPath("bad trash entry"))
		return
	}
	tr := &gitTrash{dir: filepath.Join(s.trash, req.Trash), name: req.Trash}
	data, err := os.ReadFile(filepath.Join(tr.dir, "meta.json"))
	if err != nil || json.Unmarshal(data, &tr.meta) != nil {
		done(nil, &httpError{status: 404, msg: "no such trash entry"})
		return
	}
	// The same checks as the discard: a folder the app knows, the
	// repository one of it, every path inside it.
	ctx := r.Context()
	ra, err := s.repoAt(ctx, tr.meta.Root, tr.meta.Repo)
	if err != nil {
		done(nil, err)
		return
	}
	mu, _ := gitLocks.LoadOrStore(ra.top, &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	rt, err := os.OpenRoot(ra.root)
	if err != nil {
		done(nil, &httpError{status: 404, msg: "folder not found"})
		return
	}
	defer rt.Close()
	tops := make([]string, len(tr.meta.Items))
	// First check that everything can go back, then put it back.
	for i, it := range tr.meta.Items {
		top, in, err := ra.path(it.Path)
		if err != nil || in != it.Path {
			done(nil, &httpError{status: 404, msg: "no such trash entry"})
			return
		}
		tops[i] = top
		switch it.Kind {
		case "file":
			if hashAt(ra.root, it.Path) != it.After {
				done(nil, &httpError{status: 409, msg: it.Path + " has changed since; it was not put back"})
				return
			}
		case "new":
			if _, err := rt.Lstat(filepath.FromSlash(it.Path)); err == nil {
				done(nil, &httpError{status: 409, msg: "something named " + it.Path + " is there again"})
				return
			}
		case "patch":
			patch, err := os.ReadFile(tr.item(i))
			if err != nil {
				done(nil, &httpError{status: 404, msg: "no such trash entry"})
				return
			}
			if _, err := ra.run(ctx, gitRunOpts{stdin: patch}, "apply", "--check", "--whitespace=nowarn", "-"); err != nil {
				done(nil, &httpError{status: 409, msg: it.Path + " has changed since; the hunk was not put back"})
				return
			}
		default:
			done(nil, &httpError{status: 404, msg: "no such trash entry"})
			return
		}
	}
	for i := len(tr.meta.Items) - 1; i >= 0; i-- {
		it := tr.meta.Items[i]
		p := filepath.FromSlash(it.Path)
		switch it.Kind {
		case "file":
			if !it.Had {
				err = rt.Remove(p)
				break
			}
			var src *os.File
			if src, err = os.Open(tr.item(i)); err != nil {
				break
			}
			if d := filepath.Dir(p); d != "." {
				rt.MkdirAll(d, 0o755)
			}
			var dst *os.File
			if dst, err = rt.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644); err == nil {
				_, err = io.Copy(dst, src)
				if cerr := dst.Close(); err == nil {
					err = cerr
				}
			}
			src.Close()
		case "new":
			if d := filepath.Dir(p); d != "." {
				rt.MkdirAll(d, 0o755)
			}
			if fi, e := os.Lstat(tr.item(i)); e == nil && fi.IsDir() {
				err = os.Rename(tr.item(i), filepath.Join(ra.root, p))
			} else {
				err = moveFile(tr.item(i), filepath.Join(ra.root, p))
			}
		case "patch":
			patch, _ := os.ReadFile(tr.item(i))
			_, err = ra.run(ctx, gitRunOpts{stdin: patch}, "apply", "--whitespace=nowarn", "-")
		}
		if err != nil {
			done(nil, &httpError{status: 500, msg: "could not put " + it.Path + " back: " + err.Error()})
			return
		}
	}
	tr.drop()
	writeJSON(w, struct {
		Paths []string `json:"paths"`
	}{func() []string {
		var ps []string
		for _, it := range tr.meta.Items {
			ps = append(ps, it.Path)
		}
		return ps
	}()})
}

// ---- Hunks ----

// fileDiff is one file's diff from the top of the working tree: "work"
// is what is not staged (the index to the file), "index" what is (HEAD to
// the index). Its hunks are what the hunk actions name.
func fileDiff(ctx context.Context, top, path, side string) ([]byte, error) {
	args := []string{"diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-U3"}
	if side == "index" {
		args = append(args, "--cached")
	}
	return git(ctx, top, maxDiff+1, append(args, "--", path)...)
}

// splitHunks cuts a one-file diff into its header and its hunks, each
// from its @@ line up to the next, with every byte kept.
func splitHunks(diff string) (head string, hunks []string) {
	var cur *strings.Builder
	var hb strings.Builder
	for _, l := range strings.SplitAfter(diff, "\n") {
		if strings.HasPrefix(l, "@@ ") {
			if cur != nil {
				hunks = append(hunks, cur.String())
			}
			cur = &strings.Builder{}
		}
		if cur != nil {
			cur.WriteString(l)
		} else {
			hb.WriteString(l)
		}
	}
	if cur != nil {
		hunks = append(hunks, cur.String())
	}
	return hb.String(), hunks
}

func hunkHash(h string) string {
	sum := sha256.Sum256([]byte(h))
	return hex.EncodeToString(sum[:8])
}

func (s *Server) gitHunk(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	top, in, err := ra.path(q.Path)
	if err != nil {
		return nil, err
	}
	switch {
	case q.Side == "work" && (q.Action == "stage" || q.Action == "discard"):
	case q.Side == "index" && q.Action == "unstage":
	default:
		return nil, badPath("bad hunk action")
	}
	diff, err := fileDiff(ctx, ra.top, top, q.Side)
	if err != nil {
		return nil, err
	}
	head, hunks := splitHunks(string(diff))
	if len(diff) > maxDiff || q.Index < 0 || q.Index >= len(hunks) || hunkHash(hunks[q.Index]) != q.Hash {
		return nil, &httpError{status: 409, msg: "the file has changed since its diff was shown; look again"}
	}
	patch := []byte(head + hunks[q.Index])
	var args []string
	switch q.Action {
	case "stage":
		args = []string{"apply", "--cached", "--whitespace=nowarn", "-"}
	case "unstage":
		args = []string{"apply", "--cached", "-R", "--whitespace=nowarn", "-"}
	case "discard":
		args = []string{"apply", "-R", "--whitespace=nowarn", "-"}
	}
	var tr *gitTrash
	if q.Action == "discard" {
		if tr, err = s.newGitTrash(ra); err != nil {
			return nil, err
		}
		if err := os.WriteFile(tr.item(0), patch, 0o600); err != nil {
			tr.drop()
			return nil, err
		}
		tr.meta.Items = []gitTrashItem{{Path: in, Kind: "patch"}}
	}
	if _, err := ra.run(ctx, gitRunOpts{stdin: patch}, args...); err != nil {
		if tr != nil {
			tr.drop()
		}
		return nil, err
	}
	if tr == nil {
		return nil, nil
	}
	if err := tr.save(); err != nil {
		return nil, err
	}
	return map[string]string{"trash": tr.name}, nil
}

// ---- Commit, pull, push ----

func gitCommit(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	msg := strings.TrimSpace(q.Message)
	if msg == "" {
		return nil, badPath("write a commit message first")
	}
	if q.All {
		if _, err := runGit(ctx, ra.dir, gitRunOpts{}, "add", "-A", "--", "."); err != nil {
			return nil, err
		}
	}
	merging := ra.ok(ctx, "rev-parse", "-q", "--verify", "MERGE_HEAD")
	if !merging && ra.ok(ctx, "diff", "--cached", "--quiet", "--no-ext-diff") {
		if q.All {
			return nil, &httpError{status: 409, msg: "nothing to commit: no changes"}
		}
		return nil, &httpError{status: 409, msg: "nothing to commit: nothing is staged"}
	}
	if _, err := ra.run(ctx, gitRunOpts{stdin: []byte(msg + "\n")}, "commit", "-q", "-F", "-"); err != nil {
		return nil, err
	}
	head, _ := ra.run(ctx, gitRunOpts{}, "rev-parse", "--short", "HEAD")
	res := map[string]any{"head": strings.TrimSpace(head)}
	if q.Push {
		if err := ra.push(ctx); err != nil {
			res["pushError"] = err.Error()
		} else {
			res["pushed"] = true
		}
	}
	return res, nil
}

// branch is the branch checked out, refusing a detached HEAD.
func (ra *repoAt) branch(ctx context.Context) (string, error) {
	b, err := git(ctx, ra.top, 1<<12, "symbolic-ref", "-q", "--short", "HEAD")
	if err != nil || len(bytes.TrimSpace(b)) == 0 {
		return "", &httpError{status: 409, msg: "not on a branch: a commit is checked out. Go back to a branch first"}
	}
	return strings.TrimSpace(string(b)), nil
}

func (ra *repoAt) upstream(ctx context.Context) string {
	u, err := git(ctx, ra.top, 1<<12, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(u))
}

// push sends the branch to its upstream. A branch without one goes to
// origin (or the only remote) under its own name and takes it as its
// upstream, as VS Code's Publish does.
func (ra *repoAt) push(ctx context.Context) error {
	if _, err := ra.branch(ctx); err != nil {
		return err
	}
	if ra.upstream(ctx) != "" {
		_, err := ra.run(ctx, gitRunOpts{net: true}, "push")
		return err
	}
	out, _ := git(ctx, ra.top, 1<<12, "remote")
	remotes := strings.Fields(string(out))
	remote := ""
	for _, r := range remotes {
		if r == "origin" {
			remote = r
		}
	}
	if remote == "" && len(remotes) == 1 {
		remote = remotes[0]
	}
	if remote == "" {
		if len(remotes) == 0 {
			return &httpError{status: 409, msg: "this repository has no remote to push to"}
		}
		return &httpError{status: 409, msg: "this branch has no upstream and there is no origin; push it once from a terminal"}
	}
	_, err := ra.run(ctx, gitRunOpts{net: true}, "push", "-u", remote, "HEAD")
	return err
}

func (ra *repoAt) pull(ctx context.Context) error {
	if _, err := ra.branch(ctx); err != nil {
		return err
	}
	if ra.upstream(ctx) == "" {
		return &httpError{status: 409, msg: "this branch has no upstream to pull from; push it to publish it"}
	}
	args := []string{"pull", "--no-edit"}
	// git asks how to join diverged branches unless told. A merge, as git
	// did by default for years, unless the repository says otherwise.
	if !ra.ok(ctx, "config", "--get", "pull.rebase") && !ra.ok(ctx, "config", "--get", "pull.ff") {
		args = append(args, "--no-rebase")
	}
	_, err := ra.run(ctx, gitRunOpts{net: true}, args...)
	return err
}

func gitPull(ctx context.Context, ra *repoAt, q gitReq) (any, error) { return nil, ra.pull(ctx) }
func gitPush(ctx context.Context, ra *repoAt, q gitReq) (any, error) { return nil, ra.push(ctx) }

// gitSync pulls then pushes. A branch with no upstream yet is only
// pushed (published).
func gitSync(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	if _, err := ra.branch(ctx); err != nil {
		return nil, err
	}
	if ra.upstream(ctx) != "" {
		if err := ra.pull(ctx); err != nil {
			return nil, err
		}
	}
	return nil, ra.push(ctx)
}

// ---- Branches ----

type gitBranch struct {
	Name     string `json:"name"`
	Upstream string `json:"upstream,omitempty"`
	Current  bool   `json:"current,omitempty"`
}

func (ra *repoAt) branches(ctx context.Context) ([]gitBranch, error) {
	out, err := ra.run(ctx, gitRunOpts{}, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(upstream:short)%09%(HEAD)", "refs/heads")
	if err != nil {
		return nil, err
	}
	list := []gitBranch{}
	for _, l := range strings.Split(out, "\n") {
		f := strings.Split(l, "\t")
		if len(f) != 3 || f[0] == "" {
			continue
		}
		list = append(list, gitBranch{Name: f[0], Upstream: f[1], Current: f[2] == "*"})
	}
	return list, nil
}

func (s *Server) gitBranches(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	done := s.reply(w, http.StatusOK)
	ra, err := s.repoAt(r.Context(), q.Get("root"), q.Get("repo"))
	if err != nil {
		done(nil, err)
		return
	}
	list, err := ra.branches(r.Context())
	if err != nil {
		done(nil, err)
		return
	}
	writeJSON(w, map[string]any{"branches": list})
}

func gitSwitch(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	list, err := ra.branches(ctx)
	if err != nil {
		return nil, err
	}
	for _, b := range list {
		if b.Name == q.Branch && !strings.HasPrefix(b.Name, "-") {
			_, err := ra.run(ctx, gitRunOpts{}, "switch", "-q", b.Name)
			return nil, err
		}
	}
	return nil, &httpError{status: 404, msg: "no branch named " + q.Branch}
}

func gitNewBranch(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	name := strings.TrimSpace(q.Name)
	if name == "" || strings.HasPrefix(name, "-") || !ra.ok(ctx, "check-ref-format", "--branch", name) {
		return nil, badPath("not a valid branch name")
	}
	_, err := ra.run(ctx, gitRunOpts{}, "switch", "-q", "-c", name)
	return nil, err
}

// ---- History, and going back ----

type gitCommitInfo struct {
	Sha     string   `json:"sha"`
	Short   string   `json:"short"`
	Subject string   `json:"subject"`
	Time    int64    `json:"time"` // unix seconds, the committer's
	Refs    []string `json:"refs,omitempty"`
	Out     bool     `json:"out,omitempty"`  // not pushed yet
	Here    bool     `json:"here,omitempty"` // HEAD
}

func (s *Server) gitLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	done := s.reply(w, http.StatusOK)
	ctx := r.Context()
	ra, err := s.repoAt(ctx, q.Get("root"), q.Get("repo"))
	if err != nil {
		done(nil, err)
		return
	}
	skip, _ := strconv.Atoi(q.Get("skip"))
	if skip < 0 {
		skip = 0
	}
	res := struct {
		Commits []gitCommitInfo `json:"commits"`
		More    bool            `json:"more,omitempty"`
	}{Commits: []gitCommitInfo{}}
	if !ra.hasHead(ctx) {
		writeJSON(w, res)
		return
	}
	// On a checked out commit, the branch it was left from shows too, so
	// the commits after this one stay in reach.
	branch, _ := git(ctx, ra.top, 1<<12, "symbolic-ref", "-q", "--short", "HEAD")
	tip := strings.TrimSpace(string(branch))
	refs := []string{"HEAD"}
	if tip == "" {
		if back := backBranch(ctx, ra.top); back != "" {
			tip = back
			refs = []string{back, "HEAD"}
		}
	}
	out := map[string]bool{}
	if tip != "" {
		if ahead, err := git(ctx, ra.top, 1<<20, "rev-list", "-n", "1000", tip+"@{u}.."+tip); err == nil {
			for _, sha := range strings.Fields(string(ahead)) {
				out[sha] = true
			}
		}
	}
	head, _ := git(ctx, ra.top, 1<<12, "rev-parse", "HEAD")
	args := append([]string{"log", "-z", "--format=%H%x1f%h%x1f%ct%x1f%D%x1f%s", "--skip=" + strconv.Itoa(skip), "-n", strconv.Itoa(logPage + 1)}, refs...)
	log, err := ra.run(ctx, gitRunOpts{}, append(args, "--")...)
	if err != nil {
		done(nil, err)
		return
	}
	for _, rec := range strings.Split(log, "\x00") {
		f := strings.SplitN(strings.TrimLeft(rec, "\n"), "\x1f", 5)
		if len(f) != 5 {
			continue
		}
		if len(res.Commits) == logPage {
			res.More = true
			break
		}
		c := gitCommitInfo{Sha: f[0], Short: f[1], Subject: f[4], Out: out[f[0]], Here: f[0] == strings.TrimSpace(string(head))}
		c.Time, _ = strconv.ParseInt(f[2], 10, 64)
		for _, d := range strings.Split(f[3], ", ") {
			switch {
			case d == "" || d == "HEAD" || strings.HasPrefix(d, "HEAD -> ") || d == tip || strings.HasSuffix(d, "/HEAD"):
			case strings.HasPrefix(d, "tag: "):
				c.Refs = append(c.Refs, strings.TrimPrefix(d, "tag: "))
			default:
				c.Refs = append(c.Refs, d)
			}
		}
		res.Commits = append(res.Commits, c)
	}
	writeJSON(w, res)
}

// commit resolves a hash the client names to a full one, refusing
// anything else.
func (ra *repoAt) commit(ctx context.Context, sha string) (string, error) {
	if !shaLike.MatchString(sha) {
		return "", badPath("not a commit")
	}
	full, err := git(ctx, ra.top, 1<<12, "rev-parse", "--verify", "-q", sha+"^{commit}")
	if err != nil {
		return "", &httpError{status: 404, msg: "no such commit"}
	}
	return strings.TrimSpace(string(full)), nil
}

func gitRevert(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	full, err := ra.commit(ctx, q.Sha)
	if err != nil {
		return nil, err
	}
	if parents, _ := git(ctx, ra.top, 1<<12, "rev-list", "--parents", "-n", "1", full); len(strings.Fields(string(parents))) > 2 {
		return nil, &httpError{status: 409, msg: "that is a merge commit; revert it from a terminal (git revert -m 1)"}
	}
	if _, err := ra.run(ctx, gitRunOpts{}, "revert", "--no-edit", full); err != nil {
		// A revert that stops on a conflict is taken back whole, so the
		// files are as they were.
		if ra.ok(ctx, "rev-parse", "-q", "--verify", "REVERT_HEAD") {
			ra.run(ctx, gitRunOpts{}, "revert", "--abort")
			return nil, &httpError{status: 409, msg: "reverting it conflicts with later changes, so nothing was changed. git said: " + err.Error()}
		}
		return nil, err
	}
	head, _ := ra.run(ctx, gitRunOpts{}, "rev-parse", "--short", "HEAD")
	return map[string]string{"head": strings.TrimSpace(head)}, nil
}

func gitCheckout(ctx context.Context, ra *repoAt, q gitReq) (any, error) {
	full, err := ra.commit(ctx, q.Sha)
	if err != nil {
		return nil, err
	}
	_, err = ra.run(ctx, gitRunOpts{}, "switch", "-q", "--detach", full)
	return nil, err
}

// gitSideDiff is a file's diff for the Changes panel: what is not staged
// ("work") or what is ("index"), in the file's own repository, with the
// hash of each hunk for the hunk actions. A new file's diff is the whole
// file, with no hunks to act on (it is staged or discarded whole).
func (s *Server) gitSideDiff(w http.ResponseWriter, r *http.Request, side string) {
	q := r.URL.Query()
	done := s.reply(w, http.StatusOK)
	ctx := r.Context()
	ra, err := s.repoAt(ctx, q.Get("root"), q.Get("repo"))
	if err != nil {
		done(nil, err)
		return
	}
	top, _, err := ra.path(q.Get("path"))
	if err != nil {
		done(nil, err)
		return
	}
	var out []byte
	tracked, _ := git(ctx, ra.top, 1<<12, "ls-files", "--", top)
	untracked := len(bytes.TrimSpace(tracked)) == 0
	if untracked && side == "work" {
		out, err = git(ctx, ra.top, maxDiff+1, "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", top)
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			err = nil
		}
	} else {
		out, err = fileDiff(ctx, ra.top, top, side)
	}
	if err != nil {
		done(nil, err)
		return
	}
	res := struct {
		Diff  string   `json:"diff"`
		Cut   bool     `json:"cut,omitempty"`
		Hunks []string `json:"hunks"`
	}{Hunks: []string{}}
	if len(out) > maxDiff {
		res.Diff, res.Cut = string(out[:maxDiff]), true
	} else {
		res.Diff = string(out)
		if !untracked {
			_, hunks := splitHunks(res.Diff)
			for _, h := range hunks {
				res.Hunks = append(res.Hunks, hunkHash(h))
			}
		}
	}
	writeJSON(w, res)
}
