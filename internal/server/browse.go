package server

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// browse lists the folders inside one folder, for opening a folder that
// has no sessions yet. One level per request; the browser walks. Names
// only, never file contents. Without a path it starts at the home folder.

type browseView struct {
	Path    string               `json:"path"`
	Parent  string               `json:"parent,omitempty"` // empty at a drive or file system root
	Dirs    []string             `json:"dirs"`
	Changed map[string]time.Time `json:"changed"` // by name: the newest change found inside, for sorting by date
}

// A folder's own time only moves when an entry is added or removed, not
// when a file inside is edited, so the newest change is looked for inside:
// a few levels deep and a few thousand entries at most, so a huge folder
// gives an approximate time rather than a slow list.
const (
	changedDepth   = 3
	changedEntries = 3000
)

func newestChange(dir string) time.Time {
	var newest time.Time
	budget := changedEntries
	var walk func(d string, depth int)
	walk = func(d string, depth int) {
		entries, err := os.ReadDir(d)
		if err != nil {
			return
		}
		for _, e := range entries {
			if budget--; budget < 0 {
				return
			}
			if skipDir(e.Name()) {
				continue
			}
			if fi, err := e.Info(); err == nil && fi.ModTime().After(newest) {
				newest = fi.ModTime()
			}
			if e.IsDir() && depth < changedDepth {
				walk(filepath.Join(d, e.Name()), depth+1)
			}
		}
	}
	if fi, err := os.Stat(dir); err == nil {
		newest = fi.ModTime()
	}
	walk(dir, 1)
	return newest
}

// skipDir hides folders nobody opens as a workspace, and the ones that
// would bury the list (a home folder on Windows has dozens).
func skipDir(name string) bool {
	if strings.HasPrefix(name, ".") || strings.HasPrefix(name, "$") {
		return true
	}
	switch strings.ToLower(name) {
	case "appdata", "node_modules", "application data", "local settings", "ntuser.dat", "system volume information":
		return true
	}
	return false
}

func (s *Server) browse(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			s.reply(w, http.StatusOK)(nil, err)
			return
		}
		path = home
	}
	if !filepath.IsAbs(path) {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "path must be absolute"})
		return
	}
	path = filepath.Clean(path)
	entries, err := os.ReadDir(path)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "cannot list " + path})
		return
	}
	v := browseView{Path: path, Dirs: []string{}}
	if parent := filepath.Dir(path); parent != path {
		v.Parent = parent
	}
	for _, e := range entries {
		if skipDir(e.Name()) {
			continue
		}
		// ReadDir reports links and junctions as non-directories; follow
		// them so a junctioned folder still shows.
		if e.IsDir() || (e.Type()&os.ModeSymlink != 0 && isDir(filepath.Join(path, e.Name()))) {
			v.Dirs = append(v.Dirs, e.Name())
		}
	}
	sort.Slice(v.Dirs, func(i, j int) bool { return strings.ToLower(v.Dirs[i]) < strings.ToLower(v.Dirs[j]) })
	times := make([]time.Time, len(v.Dirs))
	var wg sync.WaitGroup
	for i, d := range v.Dirs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			times[i] = newestChange(filepath.Join(path, d))
		}()
	}
	wg.Wait()
	v.Changed = make(map[string]time.Time, len(v.Dirs))
	for i, d := range v.Dirs {
		if !times[i].IsZero() {
			v.Changed[d] = times[i]
		}
	}
	writeJSON(w, v)
}

// mkdir makes one new folder, {name}, inside the folder being browsed,
// {path}, so a project can start somewhere that has nothing yet. One
// level only, and never over something that exists.
func (s *Server) mkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !filepath.IsAbs(req.Path) {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "path must be absolute"})
		return
	}
	name, ok := usableName(req.Name)
	if !ok {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "not a usable folder name"})
		return
	}
	path := filepath.Join(filepath.Clean(req.Path), name)
	if err := os.Mkdir(path, 0o755); err != nil {
		msg := "cannot make " + path
		if errors.Is(err, fs.ErrExist) {
			msg = name + " already exists"
		}
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: msg})
		return
	}
	s.reply(w, http.StatusOK)(struct {
		Path string `json:"path"`
	}{path}, nil)
}

// usableName trims a new folder's name and says whether Windows takes it.
func usableName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	return name, !(name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\:*?"<>|`) || strings.HasSuffix(name, "."))
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}
