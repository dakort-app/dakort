package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/transcript"
)

// Renaming a project folder keeps its sessions (measured 2026-11-03, see
// the NOTES in BRIEF.md). Both CLIs record the folder in each session's
// file, as it was when the session began, and the list goes by that; so
// a rename is remembered here, old path to new, and the index shows those
// sessions under the new one. Claude's own directories for the folder
// (~/.claude/projects/<encoded path>: sessions and memory) move too,
// although `--resume <id>` finds a session wherever it is. Nothing inside
// a transcript is rewritten.

type move struct {
	From string    `json:"from"`
	To   string    `json:"to"`
	At   time.Time `json:"at"` // sessions begun after it are not moved: a new folder may take the old name
}

type moveStore struct {
	file string // empty: kept in memory only (tests)
	mu   sync.Mutex
	list []move // in order made: a folder renamed twice moves through both
}

func loadMoves(file string) *moveStore {
	st := &moveStore{file: file}
	if file == "" {
		return st
	}
	data, err := os.ReadFile(file)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("moves: %v", err)
		}
		return st
	}
	if err := json.Unmarshal(data, &st.list); err != nil {
		log.Printf("moves: %s: %v", file, err)
	}
	return st
}

func (st *moveStore) add(m move) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.list = append(st.list, m)
	if err := st.save(); err != nil {
		st.list = st.list[:len(st.list)-1]
		return err
	}
	return nil
}

// save writes a temp file and renames it over the old one. Called with mu
// held.
func (st *moveStore) save() error {
	if st.file == "" {
		return nil
	}
	data, err := json.MarshalIndent(st.list, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(st.file), 0o700); err != nil {
		return err
	}
	tmp := st.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, st.file)
}

func (st *moveStore) all() []move {
	st.mu.Lock()
	defer st.mu.Unlock()
	return append([]move(nil), st.list...)
}

// apply is where a session's folder is now.
func (st *moveStore) apply(cwd string, created time.Time) string {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, m := range st.list {
		if created.After(m.At) {
			continue
		}
		if rest, ok := within(cwd, m.From); ok {
			cwd = m.To + rest
		}
	}
	return cwd
}

// within says whether p is root or inside it, and what follows root ("" or
// a separator and the rest), ignoring case where the disk does.
func within(p, root string) (string, bool) {
	p, root = filepath.Clean(p), filepath.Clean(root)
	if len(p) < len(root) {
		return "", false
	}
	head := p[:len(root)]
	same := head == root
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		same = strings.EqualFold(head, root)
	}
	if !same {
		return "", false
	}
	rest := p[len(root):]
	if rest == "" || os.IsPathSeparator(rest[0]) {
		return rest, true
	}
	if os.IsPathSeparator(root[len(root)-1]) { // a drive's root, C:\
		return string(filepath.Separator) + rest, true
	}
	return "", false
}

// occupied says the server has the session in hand: a turn running, a
// process held for background tasks, or messages queued.
func (r *runner) occupied(session string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.turns[session] != nil || len(r.queued[session]) > 0
}

// renameFolder takes {path, name}: the folder gets the new name in the
// same place, and its sessions go with it. Refused while one of them is in
// use, here or by another Claude: Windows will not rename a folder a
// process works in, and a turn would lose its folder midway.
func (s *Server) renameFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	to, err := s.moveFolder(req.Path, req.Name)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	s.reply(w, http.StatusOK)(struct {
		Path string `json:"path"`
	}{to}, nil)
}

func (s *Server) moveFolder(from, name string) (string, error) {
	s.moveMu.Lock()
	defer s.moveMu.Unlock()
	if !filepath.IsAbs(from) {
		return "", &httpError{status: 400, msg: "path must be absolute"}
	}
	from = filepath.Clean(from)
	if !isDir(from) {
		return "", &httpError{status: 400, msg: "not a folder"}
	}
	name, ok := usableName(name)
	if !ok {
		return "", &httpError{status: 400, msg: "not a usable folder name"}
	}
	to := filepath.Join(filepath.Dir(from), name)
	if to == from || filepath.Dir(from) == from {
		return "", &httpError{status: 400, msg: "that is its name already"}
	}
	// A change of case only is the same folder to Windows; anything else
	// must not be there yet.
	if _, err := os.Lstat(to); err == nil && folderKey(to) != folderKey(from) {
		return "", &httpError{status: 409, msg: "there is already a folder named " + name + " there"}
	}

	s.refresh(true)
	var mine []index.Session
	for _, sess := range s.idx.List() {
		if _, ok := within(sess.Cwd, from); ok && sess.Cwd != "" {
			if s.runner.occupied(sess.ID) {
				return "", &httpError{status: 409, msg: "a session in this project is working; rename it once that ends"}
			}
			if sess.HeldBy != 0 {
				return "", &httpError{status: 409, msg: fmt.Sprintf("another Claude has a session from this project open (pid %d); close it first", sess.HeldBy)}
			}
			mine = append(mine, sess)
		}
	}

	// A process a turn left running in the folder (a hung test run) keeps
	// Windows from renaming it; name it, with a Stop, rather than guess.
	if left := s.runner.leftoversIn(from); len(left) > 0 {
		return "", &httpError{status: 409, msg: "something a session here started is still running in the folder. Stop it, then try again.", left: left}
	}
	if err := os.Rename(from, to); err != nil {
		log.Printf("rename %s: %v", from, err)
		return "", &httpError{status: 409, msg: "Windows would not rename the folder: something has it open (Explorer, a terminal, an editor, OneDrive). Close that and try again."}
	}
	if err := s.moves.add(move{From: from, To: to, At: time.Now()}); err != nil {
		if uerr := os.Rename(to, from); uerr != nil {
			log.Printf("rename %s back: %v", to, uerr)
		}
		return "", err
	}
	s.moveProjectDirs(from, to, mine)
	s.store.move(from, to)
	s.tabs.move(from, to)
	s.refresh(true)
	s.hub.publish(Ev{Type: "folders"})
	return to, nil
}

// moveProjectDirs gives Claude's directories for the folder and the
// folders inside it the new path's names. Best effort: a session left in
// the old one still resumes (the CLI looks for it by id everywhere) and
// still lists under the new folder; only the folder's memory would be
// missed by new sessions.
func (s *Server) moveProjectDirs(from, to string, mine []index.Session) {
	// Under the index's root, not the CLI's: a test's fake root stays fake.
	name := func(cwd string) string { return filepath.Base(transcript.ProjectDir(cwd)) }
	dirs := map[string]string{} // old dir: the cwd it is for, renamed
	if d := filepath.Join(s.idx.Root, name(from)); s.idx.Root != "" && isDir(d) {
		dirs[d] = to
	}
	for _, sess := range mine {
		if sess.Provider != "claude" || sess.Path == "" {
			continue
		}
		d := filepath.Dir(sess.Path)
		rest, _ := within(sess.Cwd, from)
		// Only a directory named for the session's own folder: the name
		// is the path with every other character a dash, not reversible.
		if strings.EqualFold(filepath.Base(d), name(sess.Cwd)) {
			dirs[d] = to + rest
		}
	}
	for d, cwd := range dirs {
		dst := filepath.Join(filepath.Dir(d), name(cwd))
		if strings.EqualFold(d, dst) {
			continue
		}
		if err := mergeDir(d, dst); err != nil {
			log.Printf("move %s: %v", d, err)
		}
	}
}

// mergeDir moves src to dst, into it when dst is there already (a resume
// from the renamed folder makes one). A file dst has already stays in src.
func mergeDir(src, dst string) error {
	if _, err := os.Lstat(dst); errors.Is(err, fs.ErrNotExist) {
		return os.Rename(src, dst)
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	var first error
	for _, e := range entries {
		s, d := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		if e.IsDir() {
			err = mergeDir(s, d)
		} else if _, serr := os.Lstat(d); errors.Is(serr, fs.ErrNotExist) {
			err = os.Rename(s, d)
		} else {
			err = fmt.Errorf("%s is in both", e.Name())
		}
		if err != nil && first == nil {
			first = err
		}
	}
	os.Remove(src) // only once empty
	return first
}

// moves lists the renames whose old folder is gone, for the page: tabs,
// drafts and the address it keeps under the old path follow (local.ts).
func (s *Server) listMoves(w http.ResponseWriter, r *http.Request) {
	out := []move{}
	for _, m := range s.moves.all() {
		if _, err := os.Lstat(m.From); errors.Is(err, fs.ErrNotExist) {
			out = append(out, m)
		}
	}
	writeJSON(w, out)
}
