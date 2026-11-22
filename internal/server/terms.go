package server

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/term"
)

// Terminals: shells the page opens in a project's folder, as many as
// wanted, each in a pseudo-terminal (internal/term). They live as long as
// this server; a restart ends them. What a shell prints is kept (the last
// termKeep bytes), so a page that opens one later, or reloads, draws it
// again from there; a page reads the output as a plain byte stream and
// sends what is typed with a POST. Any logged-in page can open one, as it
// can start a turn that runs commands. Started 2026-11-21 after friends
// named the missing terminal as their reason to stay with VS Code.

const termKeep = 1 << 20

type terms struct {
	mu  sync.Mutex
	m   map[string]*termSess
	seq int
}

type termSess struct {
	id, folder, name string
	n                int // the order opened, for the tab names
	started          time.Time
	pty              term.PTY

	mu     sync.Mutex
	kept   []byte
	subs   map[chan []byte]struct{}
	exited bool
}

type termInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	N      int    `json:"n"`
	Exited bool   `json:"exited,omitempty"`
}

// termShell is the shell a terminal runs (a test may swap it).
var termShell = term.Shell

func (s *Server) termList(w http.ResponseWriter, r *http.Request) {
	root, err := s.fileRoot(r.URL.Query().Get("folder"))
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	key := canonical(root)
	s.terms.mu.Lock()
	out := []termInfo{}
	var all []*termSess
	for _, t := range s.terms.m {
		if canonical(t.folder) == key {
			all = append(all, t)
		}
	}
	s.terms.mu.Unlock()
	sort.Slice(all, func(i, j int) bool { return all[i].n < all[j].n })
	for _, t := range all {
		out = append(out, t.info())
	}
	writeJSON(w, out)
}

func (t *termSess) info() termInfo {
	t.mu.Lock()
	defer t.mu.Unlock()
	return termInfo{ID: t.id, Name: t.name, N: t.n, Exited: t.exited}
}

func (s *Server) termOpen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Folder     string `json:"folder"`
		Cols, Rows int
	}
	if !readJSON(w, r, &req) {
		return
	}
	root, err := s.fileRoot(req.Folder)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	select {
	case <-s.stop:
		s.reply(w, http.StatusOK)(nil, &httpError{status: http.StatusServiceUnavailable, msg: "the server is stopping"})
		return
	default:
	}
	sh := termShell()
	p, err := term.Start(sh, root, []string{"TERM_PROGRAM=dakort"}, req.Cols, req.Rows)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, &httpError{status: http.StatusInternalServerError, msg: "could not start a shell: " + err.Error()})
		return
	}
	b := make([]byte, 8)
	rand.Read(b)
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(sh[0])), ".exe")
	t := &termSess{id: hex.EncodeToString(b), folder: root, name: name, started: time.Now(), pty: p, subs: map[chan []byte]struct{}{}}
	s.terms.mu.Lock()
	if s.terms.m == nil {
		s.terms.m = map[string]*termSess{}
	}
	s.terms.seq++
	t.n = s.terms.seq
	s.terms.m[t.id] = t
	s.terms.mu.Unlock()
	go t.read()
	// A shell that exits by itself: on Windows the output ends only once
	// the pseudo-console is closed.
	go func() {
		p.Wait()
		p.Close()
	}()
	s.reply(w, http.StatusCreated)(t.info(), nil)
}

// read takes what the shell prints until it ends, keeps the tail and
// passes it to the pages reading.
func (t *termSess) read() {
	buf := make([]byte, 32<<10)
	for {
		n, err := t.pty.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			t.mu.Lock()
			t.kept = append(t.kept, chunk...)
			if len(t.kept) > termKeep {
				t.kept = append([]byte(nil), t.kept[len(t.kept)-termKeep:]...)
			}
			for c := range t.subs {
				select {
				case c <- chunk:
				default:
					// Fell behind: its page reads again and gets what is kept.
					delete(t.subs, c)
					close(c)
				}
			}
			t.mu.Unlock()
		}
		if err != nil {
			t.mu.Lock()
			t.exited = true
			for c := range t.subs {
				delete(t.subs, c)
				close(c)
			}
			t.mu.Unlock()
			return
		}
	}
}

func (s *Server) termGet(w http.ResponseWriter, r *http.Request) (*termSess, bool) {
	s.terms.mu.Lock()
	t := s.terms.m[r.PathValue("id")]
	s.terms.mu.Unlock()
	if t == nil {
		s.reply(w, http.StatusOK)(nil, &httpError{status: http.StatusNotFound, msg: "no such terminal (a restart ends them)"})
		return nil, false
	}
	return t, true
}

// termOut streams what the shell printed: what is kept first, then each
// new piece as it comes. It ends when the shell does.
func (s *Server) termOut(w http.ResponseWriter, r *http.Request) {
	t, ok := s.termGet(w, r)
	if !ok {
		return
	}
	rc := http.NewResponseController(w)
	rc.SetWriteDeadline(time.Time{})
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	h.Set("X-Content-Type-Options", "nosniff")

	c := make(chan []byte, 256)
	t.mu.Lock()
	kept := append([]byte(nil), t.kept...)
	exited := t.exited
	if !exited {
		t.subs[c] = struct{}{}
	}
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		if _, in := t.subs[c]; in {
			delete(t.subs, c)
			close(c)
		}
		t.mu.Unlock()
	}()
	w.WriteHeader(http.StatusOK)
	w.Write(kept)
	if rc.Flush() != nil || exited {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.stop:
			return
		case b, ok := <-c:
			if !ok {
				return
			}
			if _, err := w.Write(b); err != nil {
				return
			}
			for more := true; more; {
				select {
				case b, ok := <-c:
					if !ok {
						rc.Flush()
						return
					}
					w.Write(b)
				default:
					more = false
				}
			}
			if rc.Flush() != nil {
				return
			}
		}
	}
}

func (s *Server) termIn(w http.ResponseWriter, r *http.Request) {
	t, ok := s.termGet(w, r)
	if !ok {
		return
	}
	var req struct {
		Data string `json:"data"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if _, err := t.pty.Write([]byte(req.Data)); err != nil {
		s.reply(w, http.StatusOK)(nil, &httpError{status: http.StatusGone, msg: "the shell has ended"})
		return
	}
	writeJSON(w, struct{}{})
}

func (s *Server) termResize(w http.ResponseWriter, r *http.Request) {
	t, ok := s.termGet(w, r)
	if !ok {
		return
	}
	var req struct{ Cols, Rows int }
	if !readJSON(w, r, &req) {
		return
	}
	t.pty.Resize(req.Cols, req.Rows)
	writeJSON(w, struct{}{})
}

func (s *Server) termClose(w http.ResponseWriter, r *http.Request) {
	t, ok := s.termGet(w, r)
	if !ok {
		return
	}
	s.terms.mu.Lock()
	delete(s.terms.m, t.id)
	s.terms.mu.Unlock()
	t.pty.Close()
	writeJSON(w, struct{}{})
}

// closeAll ends every shell, when the server stops.
func (ts *terms) closeAll() {
	ts.mu.Lock()
	all := ts.m
	ts.m = nil
	ts.mu.Unlock()
	for _, t := range all {
		t.pty.Close()
	}
}
