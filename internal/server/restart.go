package server

import (
	"log"
	"net/http"
	"time"
)

// Restarting for a new build waits until no turn runs. A restart while the
// server ran a turn cut that turn's CLI off from it: the orphan went on,
// every permission request failed ("Stream closed"), and the new server
// showed the session as held by another Claude. That happened when the
// deploy was run from the very turn the server was running.
//
//	POST /api/restart   {running}: turns still to finish before it goes
//
// The server then stops taking turns at the first moment none runs and
// calls Config.Restart, which exits so the service can swap in the staged
// binary and start it (dakort setup stages it; cmd/dakort/setup.go).

// idleCheck is how often a pending restart looks for a moment with no turn.
const idleCheck = 500 * time.Millisecond

// A restart also waits for background tasks (a download, a build, a
// monitor), however long: a late update costs nothing, a task cut off
// costs its work. It used to stop them after 15 minutes counted from the
// ask, which twice killed a ship started a few minutes after the one that
// asked (2026-11-02).

func (s *Server) restartWhenIdle(w http.ResponseWriter, r *http.Request) {
	if s.restart == nil {
		http.Error(w, "restarting is not set up for this server", http.StatusNotImplemented)
		return
	}
	n := s.runner.count()
	s.restartOnce.Do(func() {
		log.Printf("restart asked for; %d turn(s) to finish first", n)
		s.done.Add(1)
		go func() {
			defer s.done.Done()
			tick := time.NewTicker(idleCheck)
			defer tick.Stop()
			for {
				select {
				case <-s.stop:
					return
				case <-tick.C:
					if s.runner.stopIfIdle() {
						log.Printf("no turn running; restarting")
						go s.restart()
						return
					}
				}
			}
		}()
	})
	writeJSON(w, map[string]int{"running": n})
}

// count is how many turns hold a session, including ones whose process is
// still exiting.
func (r *runner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.turns)
}

// stopIfIdle stops taking turns if none runs, in one step, so a send cannot
// slip in between the check and the stop. Sends then get 503 until the new
// server answers, a second or two. Processes held for background tasks
// count as running, however long their tasks take, and so does a queued
// message about to go (between one turn's exit and the next's start).
func (r *runner) stopIfIdle() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped || len(r.turns) > 0 || r.waitingToGo() {
		return false
	}
	r.stopped = true
	return true
}
