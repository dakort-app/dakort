package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/index"
)

// Folders are the home screen. A folder is a session's cwd, as in Claude
// Code. The person opens the ones they work in and closes them to tidy
// up; the list is shared by every device. Closing records when, and a
// closed folder comes back by itself once one of its sessions has activity
// after that, so work started in the terminal shows up on the phone.

type folderEntry struct {
	Path   string    `json:"path"`
	Closed time.Time `json:"closed,omitzero"` // zero while open
}

type folderStore struct {
	file string // empty: kept in memory only (tests)
	mu   sync.Mutex
	m    map[string]folderEntry // by folderKey
}

func loadFolders(file string) *folderStore {
	st := &folderStore{file: file, m: map[string]folderEntry{}}
	if file == "" {
		return st
	}
	data, err := os.ReadFile(file)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("folders: %v", err)
		}
		return st
	}
	var list []folderEntry
	if err := json.Unmarshal(data, &list); err != nil {
		log.Printf("folders: %s: %v; starting with none open", file, err)
		return st
	}
	for _, e := range list {
		st.m[folderKey(e.Path)] = e
	}
	return st
}

// set records an open (closed zero) or a close, and saves.
func (st *folderStore) set(path string, closed time.Time) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.m[folderKey(path)] = folderEntry{Path: path, Closed: closed}
	return st.save()
}

// move follows a folder's rename: it and the folders inside it keep their
// open or closed state under the new path.
func (st *folderStore) move(from, to string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for k, e := range st.m {
		if rest, ok := within(e.Path, from); ok {
			delete(st.m, k)
			e.Path = to + rest
			st.m[folderKey(e.Path)] = e
		}
	}
	if err := st.save(); err != nil {
		log.Printf("folders: %v", err)
	}
}

func (st *folderStore) entries() map[string]folderEntry {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make(map[string]folderEntry, len(st.m))
	for k, e := range st.m {
		out[k] = e
	}
	return out
}

// save writes a temp file and renames it over the old one, so a crash
// mid-write cannot empty the home screen. Called with mu held.
func (st *folderStore) save() error {
	if st.file == "" {
		return nil
	}
	list := make([]folderEntry, 0, len(st.m))
	for _, e := range st.m {
		list = append(list, e)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Path < list[j].Path })
	data, err := json.MarshalIndent(list, "", "  ")
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

// folderKey makes two spellings of one folder equal. Windows paths are
// case-insensitive, and the CLI records the drive letter both ways.
func folderKey(p string) string {
	p = filepath.Clean(p)
	// Windows and a Mac's default disk both ignore case (one folder, two
	// spellings: the C:/c: bug class); a case-sensitive Mac volume is rare.
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		p = strings.ToLower(p)
	}
	return p
}

type folderView struct {
	Path     string    `json:"path"`
	Open     bool      `json:"open,omitempty"`
	Updated  time.Time `json:"updated,omitzero"` // latest session activity
	Sessions int       `json:"sessions"`
	Running  bool      `json:"running,omitempty"`
	Missing  bool      `json:"missing,omitempty"` // gone from disk (shown only while open)
}

// folderPaths maps each folder key to the spelling of its most recently
// active session, the one the UI shows. list is newest first.
func folderPaths(list []index.Session) map[string]string {
	paths := map[string]string{}
	for _, s := range list {
		if s.Cwd == "" {
			continue
		}
		if k := folderKey(s.Cwd); paths[k] == "" {
			paths[k] = s.Cwd
		}
	}
	return paths
}

func (s *Server) folders(w http.ResponseWriter, r *http.Request) {
	s.refresh(false)
	list := s.idx.List()
	byKey := map[string]*folderView{}
	var order []string
	for _, sess := range list {
		if sess.Cwd == "" {
			continue
		}
		k := folderKey(sess.Cwd)
		f := byKey[k]
		if f == nil {
			f = &folderView{Path: sess.Cwd, Updated: sess.Updated}
			byKey[k] = f
			order = append(order, k)
		}
		f.Sessions++
		if s.runner.running(sess.ID) {
			f.Running = true
		}
	}
	for k, e := range s.store.entries() {
		f := byKey[k]
		if f == nil {
			// Opened before it had any session.
			f = &folderView{Path: e.Path}
			byKey[k] = f
			order = append(order, k)
		}
		f.Open = e.Closed.IsZero() || f.Updated.After(e.Closed)
	}
	out := make([]folderView, 0, len(order))
	for _, k := range order {
		f := byKey[k]
		if fi, err := os.Stat(f.Path); err != nil || !fi.IsDir() {
			if !f.Open {
				continue // a deleted folder (test runs leave many) is noise in Recent
			}
			f.Missing = true
		}
		out = append(out, *f)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Updated.After(out[j].Updated) })
	writeJSON(w, out)
}

// openFolder and closeFolder take {path}. Opening needs the folder to
// exist; closing does not, so a deleted folder can be cleared away.
func (s *Server) openFolder(w http.ResponseWriter, r *http.Request) {
	s.setFolder(w, r, true)
}

func (s *Server) closeFolder(w http.ResponseWriter, r *http.Request) {
	s.setFolder(w, r, false)
}

func (s *Server) setFolder(w http.ResponseWriter, r *http.Request, open bool) {
	var req struct {
		Path string `json:"path"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !filepath.IsAbs(req.Path) {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "path must be absolute"})
		return
	}
	path := filepath.Clean(req.Path)
	closed := time.Now()
	if open {
		if fi, err := os.Stat(path); err != nil || !fi.IsDir() {
			s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "not a folder"})
			return
		}
		closed = time.Time{}
	}
	if err := s.store.set(path, closed); err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	s.hub.publish(Ev{Type: "folders"})
	// The answer names the folder as the list does (its sessions' spelling),
	// so the page opens that one: Browse said C:\ where the sessions said
	// c:\, and the page opened a second, empty view of the same folder.
	if p := folderPaths(s.idx.List())[folderKey(path)]; p != "" {
		path = p
	}
	s.reply(w, http.StatusOK)(struct {
		Path string `json:"path"`
	}{path}, nil)
}
