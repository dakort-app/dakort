package server

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dakort-app/dakort/internal/procs"
)

// Leftovers are processes a session's turns started and left running after
// the turn ended: a test run that hung, a dev server, a watcher on a
// cluster job. Each session's CLI processes go in a job (procs), so they
// are known; nothing is ever stopped unasked (a monitor on a cluster job
// may be meant to run for days). They show in the session with a Stop
// each, and a folder rename refused by one names it (move.go). Found the
// hard way: a browser-check run that hung on 2026-11-02 sat in the project
// folder for a day, and no desktop tool could end it, since the server's
// processes belong to its own boot-time login.

// leftoverRef is a leftover named outside its session, in a rename's
// refusal.
type leftoverRef struct {
	procs.Info
	Session string `json:"session"`
	Title   string `json:"title,omitempty"`
}

// track puts a session's new CLI process in its job, making one on the
// first. What the process starts is then in the job too.
func (r *runner) track(session string, pid int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	job := r.jobs[session]
	if job == nil {
		var err error
		if job, err = procs.New(); err != nil {
			log.Printf("session %s: no process job: %v", session, err)
			return
		}
		r.jobs[session] = job
	}
	if err := job.Add(pid); err != nil {
		log.Printf("session %s: tracking pid %d: %v", session, pid, err)
	}
}

// noteLeftovers lists what the session's job still runs, once no turn is
// on the session, and tells viewers when that changed. An empty job is let
// go; the next turn makes a new one.
func (r *runner) noteLeftovers(session string) {
	r.mu.Lock()
	job := r.jobs[session]
	busy := r.turns[session] != nil
	r.mu.Unlock()
	if job == nil || busy {
		return
	}
	list := job.Running()
	r.mu.Lock()
	changed := !samePIDs(r.left[session], list)
	if len(list) == 0 {
		job.Close()
		delete(r.jobs, session)
		delete(r.left, session)
	} else {
		r.left[session] = list
	}
	r.mu.Unlock()
	if changed {
		r.hub.publish(Ev{Type: "leftovers", Session: session, Leftovers: list})
	}
}

func samePIDs(a, b []procs.Info) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].PID != b[i].PID {
			return false
		}
	}
	return true
}

// pollLeftovers rechecks every session with leftovers, so one that ends
// by itself disappears from the list.
func (r *runner) pollLeftovers() {
	r.mu.Lock()
	sessions := make([]string, 0, len(r.jobs))
	for s := range r.jobs {
		sessions = append(sessions, s)
	}
	r.mu.Unlock()
	for _, s := range sessions {
		r.noteLeftovers(s)
	}
}

// stopLeftover ends one leftover of the session and waits a moment for it
// to be gone, so the answer reflects the list.
func (r *runner) stopLeftover(session string, pid int) error {
	r.mu.Lock()
	job := r.jobs[session]
	r.mu.Unlock()
	if job == nil {
		return &httpError{status: 404, msg: "nothing left running from this session"}
	}
	if err := job.Stop(pid); err != nil {
		if errors.Is(err, procs.ErrNotOurs) {
			return &httpError{status: 404, msg: "that process is not one this session started, or has ended"}
		}
		return err
	}
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline) && job.Has(pid); {
		time.Sleep(50 * time.Millisecond)
	}
	r.noteLeftovers(session)
	return nil
}

// leftoversIn names the leftovers that would keep Windows from renaming
// folder: those working in it or started with it on their command line.
func (r *runner) leftoversIn(folder string) []leftoverRef {
	r.pollLeftovers()
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []leftoverRef
	for s, list := range r.left {
		for _, in := range list {
			_, inside := within(in.Dir, folder)
			if in.Dir == "" {
				inside = false
			}
			if !inside && !strings.Contains(strings.ToLower(in.Command), strings.ToLower(folder)) {
				continue
			}
			ref := leftoverRef{Info: in, Session: s}
			if sess, ok := r.idx.Get(s); ok {
				ref.Title = sess.Title
			}
			out = append(out, ref)
		}
	}
	return out
}

// stopLeftoverHandler is POST /api/sessions/{id}/leftovers/{pid}/stop.
func (s *Server) stopLeftoverHandler(w http.ResponseWriter, r *http.Request) {
	pid, err := strconv.Atoi(r.PathValue("pid"))
	if err != nil || pid <= 0 {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "bad pid"})
		return
	}
	s.reply(w, http.StatusOK)(struct{}{}, s.runner.stopLeftover(r.PathValue("id"), pid))
}
