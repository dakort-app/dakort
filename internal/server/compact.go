package server

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/dakort-app/dakort/internal/codex"
	"github.com/dakort-app/dakort/internal/transcript"
)

// Idle compaction. The CLI compacts a session left idle only in the
// terminal; headless sessions never get it (BRIEF). So the server does: a
// big session (over Above tokens of context) whose prompt cache is about
// to expire gets a "/compact" turn while the cache is still warm. Then the
// summary is cheap, and the next message after a long break reads a small
// context instead of the whole one. Past the cache's life there is no
// point: compacting would pay the same full read as the next message.
//
// Only sessions in open folders, with no turn running, not open in another
// Claude, and not switched off (on by default, per session). The model is
// the last reply's, for this turn only: the cache belongs to one model.
// A session is compacted once per reply; the compaction's own rows end the
// idle stretch, and a server restart within the window sees the boundary.

type CompactConfig struct {
	On    bool
	Above int           // context tokens; compactAbove when zero
	Lead  time.Duration // how long before the cache expires; compactLead when zero
	Every time.Duration // how often to look; compactEvery when zero
	TTL   time.Duration // the prompt cache's life (tests); when zero, each session's replies say, else the Claude settings
}

const (
	compactAbove = 200_000
	compactLead  = 5 * time.Minute
	compactEvery = time.Minute
)

func (c CompactConfig) withDefaults() CompactConfig {
	if c.Above == 0 {
		c.Above = compactAbove
	}
	if c.Lead == 0 {
		c.Lead = compactLead
	}
	if c.Every == 0 {
		c.Every = compactEvery
	}
	return c
}

// cacheTTL is the prompt cache's life as the Claude settings set it, for a
// session whose replies do not say which cache they wrote: 1 h unless the
// settings say 5 m (zero), where idle compaction would fire after 4
// minutes of quiet, which is not idle.
func cacheTTL() time.Duration {
	if readClaudeSettings().PromptCacheTTL == "5m" {
		return 0
	}
	return time.Hour
}

func (s *Server) compactLoop(c CompactConfig) {
	defer s.done.Done()
	tick := time.NewTicker(c.Every)
	defer tick.Stop()
	done := map[string]time.Time{} // session: the reply it was compacted after
	for {
		select {
		case <-s.stop:
			return
		case <-tick.C:
			s.compactIdle(c, done)
		}
	}
}

func (s *Server) compactIdle(c CompactConfig, done map[string]time.Time) {
	ttl := c.TTL
	if ttl == 0 {
		ttl = time.Hour // only the 1 h cache has an idle window; 5 m sessions are skipped below
	}
	settings5m := c.TTL == 0 && cacheTTL() == 0 // the fallback for sessions whose replies do not say
	window := func(t time.Time) bool { idle := time.Since(t); return idle >= ttl-c.Lead && idle < ttl }
	open := s.store.entries()
	for _, sess := range s.idx.List() {
		// Updated is the last user or assistant row: a quick first cut.
		// Codex has no prompt-cache clock to beat.
		if sess.Cwd == "" || sess.Provider != "claude" || !window(sess.Updated) {
			continue
		}
		if f, ok := open[folderKey(sess.Cwd)]; !ok || !(f.Closed.IsZero() || sess.Updated.After(f.Closed)) {
			continue
		}
		if s.runner.settingsOf(sess.ID).noIdleCompact || s.runner.busy(sess.ID) {
			continue
		}
		if sess.HeldBy != 0 && !s.runner.isOurs(sess.HeldBy) {
			continue
		}
		reply, life, ok := lastReply(sess.Path)
		if !ok || reply.Context < c.Above || !window(reply.Time) || !reply.Time.After(done[sess.ID]) {
			continue
		}
		// The session's own replies say which cache they wrote to; on the
		// 5-minute one, idle is not idle and the hour above is wrong.
		if c.TTL == 0 && (life == "5m" || life == "" && settings5m) {
			continue
		}
		done[sess.ID] = reply.Time
		_, err := s.runner.send(sess.ID, sendRequest{PromptID: "idle-compact-" + newUUID(), Text: "/compact", modelOnce: reply.Model, idle: true})
		if err != nil {
			log.Printf("idle compaction of %s: %v", sess.ID, err)
			continue
		}
		log.Printf("idle compaction of %s: %dk tokens, %v since the last reply", sess.ID, reply.Context/1000, time.Since(reply.Time).Round(time.Second))
	}
}

// lastReply is the last real assistant row with a context size, unless a
// compaction came after it (the session is compacted already), and the
// cache life ("1h", "5m", or "" when unknown) the latest call that wrote
// to the cache used: a reply that only read it does not say.
func lastReply(path string) (transcript.Row, string, bool) {
	rows, _, err := (&transcript.Reader{Path: path}).Tail(-1, 100)
	if err != nil {
		return transcript.Row{}, "", false
	}
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		if r.Role == transcript.System && r.Subtype == "compact_boundary" {
			return transcript.Row{}, "", false
		}
		if r.Role == transcript.Assistant && !r.APIError && r.Context > 0 {
			return r, cacheLife(rows[:i+1]), true
		}
	}
	return transcript.Row{}, "", false
}

// cacheLife is the cache the latest row that wrote one used.
func cacheLife(rows []transcript.Row) string {
	for i := len(rows) - 1; i >= 0; i-- {
		if rows[i].CacheTTL != "" {
			return rows[i].CacheTTL
		}
	}
	return ""
}

// rename gives a session a name: {title}. It runs /rename through the CLI
// (a local command: no API call), so the name is stored the CLI's way, a
// custom-title line, and shows in a terminal's /resume and VS Code too;
// the index reads it back. Refused, like a send, while another Claude
// holds the session: a second process writing would fork the transcript.
func (s *Server) rename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title string `json:"title"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	title := strings.Join(strings.Fields(req.Title), " ")
	if title == "" {
		http.Error(w, "the name is empty", http.StatusBadRequest)
		return
	}
	if sess, ok := s.idx.Get(r.PathValue("id")); ok && sess.Provider == "codex" {
		s.reply(w, http.StatusOK)(struct{}{}, s.renameCodex(r.Context(), sess.ID, sess.Cwd, title))
		return
	}
	s.reply(w, http.StatusAccepted)(s.runner.send(r.PathValue("id"), sendRequest{PromptID: "rename-" + newUUID(), Text: "/rename " + title, idle: true}))
}

// renameCodex names a thread through a short-lived app-server (no turn,
// no API call); Codex keeps the name in its own index, which the next
// poll reads.
func (s *Server) renameCodex(ctx context.Context, id, cwd, title string) error {
	if !s.runner.quiet(id) {
		return &httpError{status: 409, msg: "a turn is running in this session; rename it after"}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	p, err := codex.Start(ctx, codex.Options{Bin: s.runner.clis.Codex(), Cwd: cwd, Resume: id})
	if err != nil {
		return &httpError{status: 502, msg: "opening the thread: " + err.Error()}
	}
	defer p.Close()
	if err := p.Rename(ctx, title); err != nil {
		return &httpError{status: 502, msg: err.Error()}
	}
	s.refresh(true)
	s.hub.publish(Ev{Type: "sessions"})
	return nil
}

// sessionSettings switches a session's idle compaction {idleCompact}, and
// keeps an effort, Ultracode or Chrome picked in the menu {effort, ultracode, chrome} at
// once, without a turn: a pick used to live in the page until the next
// send, so a tab switch or a reload lost it (a contributor's branch, 5221579). The
// next turn's CLI gets it; effort "default" clears it.
func (s *Server) sessionSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IdleCompact *bool  `json:"idleCompact"`
		Effort      string `json:"effort"`
		Ultracode   *bool  `json:"ultracode"`
		Chrome      *bool  `json:"chrome"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Effort != "" && !effortName(req.Effort) {
		http.Error(w, "effort is a level's name (low, high, ...) or default", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	if req.IdleCompact != nil {
		s.runner.setIdleCompact(id, *req.IdleCompact)
	}
	if req.Effort != "" || req.Ultracode != nil || req.Chrome != nil {
		s.runner.settings(id, sendRequest{Effort: req.Effort, Ultracode: req.Ultracode, Chrome: req.Chrome})
	}
	if req.IdleCompact != nil || req.Effort != "" || req.Ultracode != nil || req.Chrome != nil {
		s.hub.publish(Ev{Type: "sessions"}) // other devices show it
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// effortName: a short lowercase word, as the CLIs name their levels (Codex
// adds its own), never a flag or anything else.
func effortName(v string) bool {
	if len(v) > 16 {
		return false
	}
	for _, c := range v {
		if c < 'a' || c > 'z' {
			return false
		}
	}
	return true
}
