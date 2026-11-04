package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Seen is how far the person has read each session: the session's
// updated time when it was last on screen, on any device. It was kept per
// browser, so an answer read on the phone stayed unread on the laptop.
// Sessions never opened count as seen up to since, when this store was
// made, so a first start does not light up every old session.

type seenStore struct {
	file  string // empty: kept in memory only (tests)
	mu    sync.Mutex
	since time.Time
	m     map[string]time.Time
}

type seenFile struct {
	Since time.Time            `json:"since"`
	Seen  map[string]time.Time `json:"seen"`
}

func loadSeen(file string) *seenStore {
	st := &seenStore{file: file, since: time.Now(), m: map[string]time.Time{}}
	if file == "" {
		return st
	}
	data, err := os.ReadFile(file)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("seen: %v", err)
		}
		if err := st.save(); err != nil { // since is now, from here on
			log.Printf("seen: %v", err)
		}
		return st
	}
	var f seenFile
	if err := json.Unmarshal(data, &f); err != nil {
		log.Printf("seen: %s: %v; counting everything as read up to now", file, err)
		return st
	}
	if !f.Since.IsZero() {
		st.since = f.Since
	}
	for id, t := range f.Seen {
		st.m[id] = t
	}
	return st
}

// get is how far the session has been read.
func (st *seenStore) get(id string) time.Time {
	st.mu.Lock()
	defer st.mu.Unlock()
	if t := st.m[id]; t.After(st.since) {
		return t
	}
	return st.since
}

// mark records that the session was read up to t; false when it already
// was (a second device, or the same one again).
func (st *seenStore) mark(id string, t time.Time) (bool, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if !t.After(st.m[id]) || !t.After(st.since) {
		return false, nil
	}
	st.m[id] = t
	return true, st.save()
}

// save writes a temp file and renames it over the old one. Called with mu
// held, or before the store is shared.
func (st *seenStore) save() error {
	if st.file == "" {
		return nil
	}
	data, err := json.MarshalIndent(seenFile{Since: st.since, Seen: st.m}, "", "  ")
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

// markSeen is POST /api/sessions/{id}/seen {updated}: the session was on
// screen with that updated time. Every device's list refreshes, so its
// dot and the page title's count go there too.
func (s *Server) markSeen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Updated time.Time `json:"updated"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil || req.Updated.IsZero() {
		http.Error(w, "want {updated}", http.StatusBadRequest)
		return
	}
	changed, err := s.seen.mark(r.PathValue("id"), req.Updated)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if changed {
		s.hub.publish(Ev{Type: "sessions"})
	}
	writeJSON(w, struct{}{})
}
