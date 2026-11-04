package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// The open tabs of a folder are the project's, shared by every device:
// which sessions and files are open there, in order. Each browser kept
// its own list, and a browser kept one per address it used, so the phone,
// the laptop and the laptop's second address each showed a different
// past. Which tab is on screen, the split and the drafts stay with the
// device (web/src/local.ts).
//
//	GET  /api/tabs?folder=F   {ids}: the list; ids null when no device has told the server about F yet (the first to open F then seeds it with what it had)
//	POST /api/tabs            {folder, ids}: replaces the list; every device hears a tabs event

const (
	maxTabs   = 200
	maxTabLen = 1000
)

type tabEntry struct {
	Path string   `json:"path"`
	IDs  []string `json:"ids"`
}

type tabStore struct {
	file string // empty: kept in memory only (tests)
	mu   sync.Mutex
	m    map[string]tabEntry // by folderKey
}

func loadTabs(file string) *tabStore {
	st := &tabStore{file: file, m: map[string]tabEntry{}}
	if file == "" {
		return st
	}
	data, err := os.ReadFile(file)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("tabs: %v", err)
		}
		return st
	}
	var list []tabEntry
	if err := json.Unmarshal(data, &list); err != nil {
		log.Printf("tabs: %s: %v; starting with none", file, err)
		return st
	}
	for _, e := range list {
		st.m[folderKey(e.Path)] = e
	}
	return st
}

// get is the folder's list, and whether the folder is known at all.
func (st *tabStore) get(path string) ([]string, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	e, ok := st.m[folderKey(path)]
	if !ok {
		return nil, false
	}
	return append([]string{}, e.IDs...), true
}

func (st *tabStore) set(path string, ids []string) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.m[folderKey(path)] = tabEntry{Path: path, IDs: append([]string{}, ids...)}
	return st.save()
}

// move follows a folder's rename: it and the folders inside it keep their
// tabs under the new path (file tabs are relative to the folder).
func (st *tabStore) move(from, to string) {
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
		log.Printf("tabs: %v", err)
	}
}

// save writes a temp file and renames it over the old one. Called with mu
// held.
func (st *tabStore) save() error {
	if st.file == "" {
		return nil
	}
	list := make([]tabEntry, 0, len(st.m))
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

func (s *Server) getTabs(w http.ResponseWriter, r *http.Request) {
	folder := r.URL.Query().Get("folder")
	if folder == "" {
		http.Error(w, "folder is required", http.StatusBadRequest)
		return
	}
	ids, ok := s.tabs.get(folder)
	if !ok {
		writeJSON(w, struct {
			IDs []string `json:"ids"`
		}{nil})
		return
	}
	if ids == nil {
		ids = []string{}
	}
	writeJSON(w, struct {
		IDs []string `json:"ids"`
	}{ids})
}

func (s *Server) setTabs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Folder string   `json:"folder"`
		IDs    []string `json:"ids"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Folder == "" {
		http.Error(w, "folder is required", http.StatusBadRequest)
		return
	}
	if len(req.IDs) > maxTabs {
		http.Error(w, "too many tabs", http.StatusBadRequest)
		return
	}
	for _, id := range req.IDs {
		if id == "" || len(id) > maxTabLen {
			http.Error(w, "bad tab id", http.StatusBadRequest)
			return
		}
	}
	if req.IDs == nil {
		req.IDs = []string{}
	}
	if err := s.tabs.set(req.Folder, req.IDs); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.hub.publish(Ev{Type: "tabs", Folder: req.Folder, Tabs: req.IDs})
	writeJSON(w, struct{}{})
}
