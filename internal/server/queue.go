package server

import (
	"log"
	"net/http"
	"slices"

	"github.com/dakort-app/dakort/internal/agent"
)

// A message sent while a turn runs waits in the session's queue, on the
// server, and goes when the turn ends: so it goes even if the phone that
// queued it has gone to sleep. One goes per turn end, in order; the next
// waits for the turn it started. A stop hands the queue back to whoever
// pressed it (their box gets the texts), as Claude Code's Escape does, so
// a turn stopped for going wrong does not run on into the next message.
//
//	POST   /api/sessions/{id}/send {queue: true, ...}  queued while a turn runs ({queued: true}); else sent
//	POST   /api/sessions/{id}/unqueue/{promptId}      taken back: {text, images}; 404 once it went
//	POST   /api/sessions/{id}/interrupt               {queued: [{text, images}]}: the queue, taken back
//
// The queue event carries a session's queue whole (empty: none left), and
// the snapshot every session's. A queued message whose send failed stays
// first in line with its error, and goes after the next turn; the restart
// for a new build does not wait for those.

type Queued struct {
	PromptID string `json:"promptId"`
	Text     string `json:"text"`
	Images   int    `json:"images,omitempty"`
	Error    string `json:"error,omitempty"` // the last try failed, and why
}

// TakenBack is a queued message returned to the composer.
type TakenBack struct {
	Text   string        `json:"text"`
	Images []agent.Image `json:"images"`
}

type waiting struct {
	req sendRequest
	err string
}

// enqueue queues req if the session has a turn running, or messages queued
// already (they keep their order). ok false: send it now.
func (r *runner) enqueue(session string, req sendRequest) (_ sendReply, ok bool) {
	if session == "" || req.PromptID == "" || req.Text == "" && len(req.Images) == 0 {
		return sendReply{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	reply := sendReply{Session: session, PromptID: req.PromptID, Queued: true}
	q := r.queued[session]
	if slices.ContainsFunc(q, func(w waiting) bool { return w.req.PromptID == req.PromptID }) {
		reply.Duplicate = true
		return reply, true
	}
	t := r.turns[session]
	if r.stopped || (t == nil || !t.open) && len(q) == 0 {
		return sendReply{}, false
	}
	r.queued[session] = append(q, waiting{req: req})
	r.publishQueue(session)
	return reply, true
}

// drain sends the first queued message once a turn has ended. reserve
// waits for the ended turn's process to exit, or hands the message to it
// if it is held for background tasks.
func (r *runner) drain(session string) {
	r.mu.Lock()
	q := r.queued[session]
	if len(q) == 0 || r.stopped {
		r.mu.Unlock()
		return
	}
	w := q[0]
	r.setQueue(session, q[1:])
	r.mu.Unlock()
	if _, err := r.send(session, w.req); err != nil {
		log.Printf("session %s: a queued message: %v", session, err)
		r.mu.Lock()
		w.err = err.Error()
		r.setQueue(session, append([]waiting{w}, r.queued[session]...))
		r.mu.Unlock()
	}
}

// takeBack removes one queued message, or all of them for an empty id.
func (r *runner) takeBack(session, promptID string) []TakenBack {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []TakenBack
	keep := []waiting{}
	for _, w := range r.queued[session] {
		if promptID == "" || w.req.PromptID == promptID {
			out = append(out, TakenBack{Text: w.req.Text, Images: w.req.Images})
		} else {
			keep = append(keep, w)
		}
	}
	if out != nil {
		r.setQueue(session, keep)
	}
	return out
}

// waitingToGo says whether a queued message will go by itself after the
// running turn, so a restart waits for it. Called with mu held.
func (r *runner) waitingToGo() bool {
	for _, q := range r.queued {
		if len(q) > 0 && q[0].err == "" {
			return true
		}
	}
	return false
}

// setQueue and publishQueue are called with mu held, so two changes reach
// the stream in the order they were made.
func (r *runner) setQueue(session string, q []waiting) {
	if len(q) == 0 {
		delete(r.queued, session)
	} else {
		r.queued[session] = q
	}
	r.publishQueue(session)
}

func (r *runner) publishQueue(session string) {
	list := []Queued{}
	for _, w := range r.queued[session] {
		list = append(list, Queued{PromptID: w.req.PromptID, Text: w.req.Text, Images: len(w.req.Images), Error: w.err})
	}
	r.hub.publish(Ev{Type: "queue", Session: session, Queue: list})
}

func (s *Server) unqueue(w http.ResponseWriter, r *http.Request) {
	if !readJSON(w, r, &struct{}{}) {
		return
	}
	out := s.runner.takeBack(r.PathValue("id"), r.PathValue("promptId"))
	if len(out) == 0 {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 404, msg: "not queued (it may have been sent)"})
		return
	}
	writeJSON(w, out[0])
}

// queueOrSend is the send endpoint's: a message marked queue waits while a
// turn runs.
func (s *Server) queueOrSend(session string, req sendRequest) (sendReply, error) {
	if req.Queue {
		if rep, ok := s.runner.enqueue(session, req); ok {
			return rep, nil
		}
	}
	return s.runner.send(session, req)
}
