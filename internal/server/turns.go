package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/agent"
	"github.com/dakort-app/dakort/internal/claude"
	"github.com/dakort-app/dakort/internal/codex"
	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/procs"
)

// process is a turn's CLI, Claude's or Codex's. What only Claude can do
// (background tasks, switching a live process's model and mode) is asked
// for by assertion where it is needed.
type process interface {
	agent.Process
	PID() int
}

type taskStopper interface {
	StopTask(ctx context.Context, id string) error
}

type liveSwitcher interface {
	SetModel(ctx context.Context, model string) error
	SetPermissionMode(ctx context.Context, mode string) error
}

// One CLI process per turn: start (resuming the session), send the prompt,
// stream to the result, close. The runner holds what is live: the running
// turns, their pending permissions, and the prompt ids already accepted.
//
// Unless the turn left background tasks running (a Bash run in the
// background, a Monitor): then the process stays, held, because only a live
// CLI wakes the model when a task ends or a monitor prints, with a turn of
// its own (measured, BRIEF "Background tasks"). A send to a held session
// goes into that process; it closes once its tasks are gone.

// promptMemory is how long a prompt id is remembered, so a send retried
// after a lost response is recognised instead of run twice.
const promptMemory = 30 * time.Minute

// exitWait is how long a send waits for the previous turn's process to
// exit (it takes up to a second after the result) before reporting busy.
const exitWait = 5 * time.Second

// heldLinger is how long a held process stays once its last task is gone
// without the wake-up turn that normally follows; then it is closed.
const heldLinger = 30 * time.Second

// controlWait bounds a control request to a live process (stop a task,
// change the model).
const controlWait = 10 * time.Second

type httpError struct {
	status int
	msg    string
	heldBy int
	left   []leftoverRef // a rename refused by processes a session left running (leftovers.go)
}

func (e *httpError) Error() string { return e.msg }

type sendRequest struct {
	PromptID string        `json:"promptId"`
	Cwd      string        `json:"cwd"`      // new sessions only
	Provider string        `json:"provider"` // new sessions only: "claude" (the default) or "codex"
	Text     string        `json:"text"`
	Images   []agent.Image `json:"images"` // {mediaType, data: base64}
	// Model, Effort and PermissionMode: empty keeps what the session had;
	// "default" goes back to the CLI's own default.
	Model          string `json:"model"`
	Effort         string `json:"effort"`
	PermissionMode string `json:"permissionMode"`
	Ultracode      *bool  `json:"ultracode"` // nil keeps what the session had
	Chrome         *bool  `json:"chrome"`    // Claude in Chrome's tools; nil keeps what the session had
	// Force sends even though another process holds the session. Both
	// then append to the transcript as separate branches (see NOTES).
	Force bool `json:"force"`
	// Queue waits while a turn runs, rather than be refused (queue.go).
	Queue bool `json:"queue"`

	// Set by the server only (compact.go): the model for this turn alone,
	// not saved as the session's choice; and the turn is an idle compaction.
	modelOnce string
	idle      bool
}

type sendReply struct {
	Session   string `json:"session"`
	PromptID  string `json:"promptId"`
	Duplicate bool   `json:"duplicate,omitempty"`
	Queued    bool   `json:"queued,omitempty"` // waits for the running turn
}

type sessionSettings struct {
	model, effort, permissionMode string
	ultracode                     bool
	chrome                        bool // off by default: the 18 tools cost context on every turn
	noIdleCompact                 bool // idle compaction is on unless switched off
}

// turn is a session's CLI process: one turn, or several when it is held
// for background tasks.
type turn struct {
	session  string
	promptID string
	idle     bool // an idle compaction, not a turn someone sent
	proc     process
	open     bool            // a turn is announced and its done not yet published
	unechoed bool            // a prompt was sent and the CLI has not echoed it yet
	inits    int             // turns the process has started; settle tells a new one by it
	slot     bool            // holds one of the runner's slots (a held process does not)
	closing  bool            // the result is in; the process is exiting
	held     bool            // between turns, kept alive for its background tasks
	stopNext bool            // a stop came before the CLI took the prompt up: interrupt at its init
	tasks    []agent.Task    // the background tasks running now
	st       sessionSettings // what the process was started with or switched to
	exited   chan struct{}   // closed once the turn is fully over
	perms    map[string]bool
	model    string // the model of the turn running, from its init
}

type runner struct {
	hub          *hub
	idx          *index.Index
	clis         *cliPaths     // claude and codex; a send names what to install when missing
	slots        chan struct{} // caps concurrent CLI processes
	onEnd        func()        // a turn ended: refresh the index
	mu           sync.Mutex
	turns        map[string]*turn // by session id
	prompts      map[string]promptRecord
	setting      map[string]sessionSettings // per session, not per browser
	settingsFile string                     // where setting is kept; memory only when empty
	queued       map[string][]waiting       // by session: messages sent while a turn ran (queue.go)
	jobs         map[string]*procs.Job      // by session: the register of what its processes start (leftovers.go)
	left         map[string][]procs.Info    // by session: what its last turn left running
	stopped      bool
}

type promptRecord struct {
	reply sendReply
	at    time.Time
}

func newRunner(h *hub, idx *index.Index, bin, codexBin string, maxTurns int, onEnd func()) *runner {
	return &runner{
		hub: h, idx: idx, clis: newCLIPaths(bin, codexBin), onEnd: onEnd,
		slots:   make(chan struct{}, maxTurns),
		turns:   map[string]*turn{},
		prompts: map[string]promptRecord{},
		setting: map[string]sessionSettings{},
		queued:  map[string][]waiting{},
		jobs:    map[string]*procs.Job{},
		left:    map[string][]procs.Info{},
	}
}

// send starts a turn. session is empty for a new session. It returns once
// the CLI is running and the prompt is handed to the turn; that is the ack.
func (r *runner) send(session string, req sendRequest) (sendReply, error) {
	r.mu.Lock()
	stopped := r.stopped
	r.mu.Unlock()
	if stopped {
		return sendReply{}, &httpError{status: 503, msg: "server is shutting down"}
	}
	if req.PromptID == "" {
		return sendReply{}, &httpError{status: 400, msg: "promptId is required"}
	}
	if req.Text == "" && len(req.Images) == 0 {
		return sendReply{}, &httpError{status: 400, msg: "empty prompt"}
	}
	var cwd string
	provider := req.Provider
	resume := session != ""
	if resume {
		s, ok := r.idx.Get(session)
		if !ok {
			r.idx.Refresh()
			if s, ok = r.idx.Get(session); !ok {
				return sendReply{}, &httpError{status: 404, msg: "no such session"}
			}
		}
		if s.Cwd == "" {
			return sendReply{}, &httpError{status: 409, msg: "session has no rows to resume"}
		}
		// The first row's cwd: the CLI files the transcript under it.
		cwd, provider = s.Cwd, s.Provider
		if s.HeldBy != 0 && !req.Force && !r.isOurs(s.HeldBy) {
			return sendReply{}, &httpError{status: 409, heldBy: s.HeldBy,
				msg: fmt.Sprintf("session is open in another Claude process (pid %d); sending now would fork it", s.HeldBy)}
		}
	} else {
		if !filepath.IsAbs(req.Cwd) {
			return sendReply{}, &httpError{status: 400, msg: "cwd must be an absolute path"}
		}
		if fi, err := os.Stat(req.Cwd); err != nil || !fi.IsDir() {
			return sendReply{}, &httpError{status: 400, msg: "cwd is not a folder"}
		}
		cwd = req.Cwd
	}
	if provider == "" {
		provider = "claude"
	}
	bin, codexBin := r.clis.Claude(), r.clis.Codex()
	switch {
	case provider == "claude" && bin == "":
		return sendReply{}, &httpError{status: 500, msg: "Claude Code is not installed on this machine. In " + shellName() + ", run: " + installHint("claude", "") + " ; then run claude once to sign in."}
	case provider == "codex" && codexBin == "":
		return sendReply{}, &httpError{status: 500, msg: "Codex is not installed on this machine. In " + shellName() + ", run: " + installHint("codex", "") + " ; then run codex once to sign in."}
	case provider != "claude" && provider != "codex":
		return sendReply{}, &httpError{status: 400, msg: "unknown provider " + provider}
	}

	t, reply, reuse, err := r.reserve(session, req)
	if err != nil || t == nil {
		return reply, err
	}
	session = t.session

	st := r.settings(session, req)
	if reuse {
		r.sendHeld(t, st, req)
		return reply, nil
	}
	var proc process
	if provider == "codex" {
		co := codex.Options{Bin: codexBin, Cwd: cwd, Model: st.model, Effort: st.effort, PermissionMode: st.permissionMode}
		if resume {
			co.Resume = session
		}
		var cp *codex.Process
		cp, err = codex.Start(context.Background(), co)
		if err == nil && !resume {
			// Codex picks the thread id; the turn and the prompt were
			// filed under a placeholder.
			session = r.rekey(t, cp.SessionID())
			reply.Session = session
			if req.modelOnce != "" { // never for Codex, kept honest
				log.Printf("session %s: a once-only model is not supported for Codex", session)
			}
		}
		proc = cp
	} else {
		opts := claude.Options{
			Bin: bin, Cwd: cwd, Model: st.model, Effort: st.effort, PermissionMode: st.permissionMode,
			ReplayUserMessages: true, Chrome: st.chrome,
		}
		if st.ultracode {
			opts.Settings = `{"ultracode":true}`
		}
		if req.modelOnce != "" {
			opts.Model = req.modelOnce
		}
		if resume {
			opts.Resume = session
		} else {
			opts.SessionID = session
		}
		proc, err = claude.Start(context.Background(), opts)
	}
	if err != nil {
		r.release(t, true)
		return sendReply{}, &httpError{status: 500, msg: "starting " + provider + ": " + err.Error()}
	}
	r.track(session, proc.PID())
	r.mu.Lock()
	t.proc = proc
	t.st = st
	if r.stopped {
		go proc.Close() // stop began while it started; run sees the exit
	}
	r.mu.Unlock()
	r.hub.publish(Ev{Type: "turn", Session: session, PromptID: req.PromptID, State: "starting", Idle: req.idle})
	go r.run(t, proc, agent.Message{Text: req.Text, Images: req.Images})
	return reply, nil
}

// rekey files a turn under the id the CLI chose, with its settings and
// its prompt record, and returns it.
func (r *runner) rekey(t *turn, id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	old := t.session
	if old == id {
		return id
	}
	delete(r.turns, old)
	t.session = id
	r.turns[id] = t
	if st, ok := r.setting[old]; ok {
		delete(r.setting, old)
		r.setting[id] = st
		r.saveSettings()
	}
	if rec, ok := r.prompts[t.promptID]; ok {
		rec.reply.Session = id
		r.prompts[t.promptID] = rec
	}
	return id
}

// reserve claims the session and a process slot, or explains why not. A
// nil turn with a nil error is a duplicate send; reply is the original.
// reuse is a held process taking the prompt: no new process or slot.
func (r *runner) reserve(session string, req sendRequest) (_ *turn, _ sendReply, reuse bool, _ error) {
	deadline := time.Now().Add(exitWait)
	r.mu.Lock()
	defer r.mu.Unlock()
	for {
		if r.stopped {
			return nil, sendReply{}, false, &httpError{status: 503, msg: "server is shutting down"}
		}
		r.forgetOldPrompts()
		if rec, ok := r.prompts[req.PromptID]; ok {
			rep := rec.reply
			rep.Duplicate = true
			return nil, rep, false, nil
		}
		t := r.turns[session]
		if session == "" || t == nil {
			break
		}
		if t.held && !t.open {
			t.held, t.open, t.unechoed = false, true, echoed(req)
			t.promptID, t.idle = req.PromptID, req.idle
			r.takeSlot(t)
			reply := sendReply{Session: session, PromptID: req.PromptID}
			r.prompts[req.PromptID] = promptRecord{reply: reply, at: time.Now()}
			return t, reply, true, nil
		}
		if !t.closing {
			return nil, sendReply{}, false, &httpError{status: 409, msg: "a turn is already running in this session"}
		}
		if time.Now().After(deadline) {
			return nil, sendReply{}, false, &httpError{status: 409, msg: "the previous turn's process has not exited yet; try again shortly"}
		}
		// The answer is complete and the process is exiting; a second
		// process must not open the session before it has.
		r.mu.Unlock()
		select {
		case <-t.exited:
		case <-time.After(time.Until(deadline)):
		}
		r.mu.Lock()
	}
	select {
	case r.slots <- struct{}{}:
	default:
		return nil, sendReply{}, false, &httpError{status: 503, msg: fmt.Sprintf("%d turns are already running; try again when one ends", cap(r.slots))}
	}
	if session == "" {
		session = newUUID()
	}
	t := &turn{session: session, promptID: req.PromptID, idle: req.idle, open: true, unechoed: echoed(req), slot: true, exited: make(chan struct{}), perms: map[string]bool{}}
	r.turns[session] = t
	reply := sendReply{Session: session, PromptID: req.PromptID}
	r.prompts[req.PromptID] = promptRecord{reply: reply, at: time.Now()}
	return t, reply, false, nil
}

// sendHeld hands a prompt to a held process. The model and permission mode
// are switched first if the send changed them; effort, Ultracode and Chrome are
// flags only, so they apply from the next fresh process.
func (r *runner) sendHeld(t *turn, st sessionSettings, req sendRequest) {
	r.mu.Lock()
	proc, was := t.proc, t.st
	t.st.model, t.st.permissionMode = st.model, st.permissionMode
	r.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), controlWait)
	defer cancel()
	orDefault := func(v string) string {
		if v == "" {
			return "default"
		}
		return v
	}
	if sw, ok := proc.(liveSwitcher); ok {
		if st.model != was.model {
			if err := sw.SetModel(ctx, orDefault(st.model)); err != nil {
				log.Printf("session %s: switching the held process's model: %v", t.session, err)
			}
		}
		if st.permissionMode != was.permissionMode {
			if err := sw.SetPermissionMode(ctx, orDefault(st.permissionMode)); err != nil {
				log.Printf("session %s: switching the held process's mode: %v", t.session, err)
			}
		}
	}
	r.hub.publish(Ev{Type: "turn", Session: t.session, PromptID: req.PromptID, State: "starting", Idle: req.idle})
	if err := proc.Send(agent.Message{Text: req.Text, Images: req.Images}); err != nil {
		// The process is gone; its exit event ends the turn with an error.
		log.Printf("session %s: send to held process: %v", t.session, err)
	}
}

// release frees the session and the slot. forget drops the prompt id too,
// for a turn that never started, so the same send can be retried.
func (r *runner) release(t *turn, forget bool) {
	r.mu.Lock()
	if r.turns[t.session] == t {
		delete(r.turns, t.session)
	}
	if forget {
		delete(r.prompts, t.promptID)
	}
	r.dropSlot(t)
	r.mu.Unlock()
	close(t.exited)
}

// echoed says the CLI will echo the prompt back (a replay row). Slash
// commands (/compact, /rename) it runs without one, so their result is
// theirs whenever it comes.
func echoed(req sendRequest) bool {
	return !strings.HasPrefix(strings.TrimSpace(req.Text), "/")
}

// A held process gives its slot back, so sessions waiting on long tasks
// (a monitor can run for days) do not lock everyone else out of the cap.
// It takes one again when a turn starts in it, if one is free; if none is,
// the turn runs over the cap rather than be refused: it is already running.
// Both are called with mu held.
func (r *runner) takeSlot(t *turn) {
	if t.slot {
		return
	}
	select {
	case r.slots <- struct{}{}:
		t.slot = true
	default:
	}
}

func (r *runner) dropSlot(t *turn) {
	if t.slot {
		<-r.slots
		t.slot = false
	}
}

func (r *runner) forgetOldPrompts() {
	for id, rec := range r.prompts {
		if time.Since(rec.at) > promptMemory {
			delete(r.prompts, id)
		}
	}
}

// settings remembers the model, effort, permission mode and Ultracode per
// session, so a send from another device that names none of them keeps
// what the session had. "default" clears a choice.
func (r *runner) settings(session string, req sendRequest) sessionSettings {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.setting[session]
	pick := func(cur *string, v string) {
		switch v {
		case "":
		case "default":
			*cur = ""
		default:
			*cur = v
		}
	}
	pick(&st.model, req.Model)
	pick(&st.effort, req.Effort)
	pick(&st.permissionMode, req.PermissionMode)
	if req.Ultracode != nil {
		st.ultracode = *req.Ultracode
	}
	if req.Chrome != nil {
		st.chrome = *req.Chrome
	}
	if r.setting[session] != st {
		r.setting[session] = st
		r.saveSettings()
	}
	return st
}

// The choices are kept in a file, so a restart does not forget them (seen:
// after one, a Haiku session's picker showed the default model).
type savedSettings struct {
	Model          string `json:"model,omitempty"`
	Effort         string `json:"effort,omitempty"`
	PermissionMode string `json:"permissionMode,omitempty"`
	Ultracode      bool   `json:"ultracode,omitempty"`
	Chrome         bool   `json:"chrome,omitempty"`
	NoIdleCompact  bool   `json:"noIdleCompact,omitempty"`
}

func (r *runner) loadSettings(file string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.settingsFile = file
	if file == "" {
		return
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return
	}
	var saved map[string]savedSettings
	if json.Unmarshal(data, &saved) != nil {
		log.Printf("session settings file %s is damaged; starting without it", file)
		return
	}
	for id, s := range saved {
		r.setting[id] = sessionSettings{model: s.Model, effort: s.Effort, permissionMode: s.PermissionMode, ultracode: s.Ultracode, chrome: s.Chrome, noIdleCompact: s.NoIdleCompact}
	}
}

// saveSettings writes the choices through a temp file and a rename. Called
// with mu held.
func (r *runner) saveSettings() {
	if r.settingsFile == "" {
		return
	}
	out := make(map[string]savedSettings, len(r.setting))
	for id, s := range r.setting {
		if s != (sessionSettings{}) {
			out[id] = savedSettings{Model: s.model, Effort: s.effort, PermissionMode: s.permissionMode, Ultracode: s.ultracode, Chrome: s.chrome, NoIdleCompact: s.noIdleCompact}
		}
	}
	data, _ := json.MarshalIndent(out, "", " ")
	os.MkdirAll(filepath.Dir(r.settingsFile), 0o700)
	tmp := r.settingsFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		log.Printf("saving session settings: %v", err)
		return
	}
	if err := os.Rename(tmp, r.settingsFile); err != nil {
		log.Printf("saving session settings: %v", err)
	}
}

// setIdleCompact switches idle compaction for a session; on is the default.
func (r *runner) setIdleCompact(session string, on bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.setting[session]
	if st.noIdleCompact == !on {
		return
	}
	st.noIdleCompact = !on
	r.setting[session] = st
	r.saveSettings()
}

func (r *runner) settingsOf(session string) sessionSettings {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.setting[session]
}

func (r *runner) isOurs(pid int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.turns {
		if t.proc != nil && t.proc.PID() == pid {
			return true
		}
	}
	return false
}

// ourPIDs are the CLI processes this server runs, which the registry
// lists as holding their sessions.
func (r *runner) ourPIDs() map[int]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	pids := map[int]bool{}
	for _, t := range r.turns {
		if t.proc != nil {
			pids[t.proc.PID()] = true
		}
	}
	return pids
}

// running says a turn is under way in the session (not a held process
// waiting between turns).
func (r *runner) running(session string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	t := r.turns[session]
	return t != nil && !t.closing && !t.held
}

// busy says the server has a CLI process on the session at all, running a
// turn or held for background tasks.
func (r *runner) busy(session string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.turns[session] != nil
}

// quiet waits, up to exitWait, for a finished turn's process to be gone
// (it exits a moment after the result), and says whether the session is
// then free: no turn running, none held.
func (r *runner) quiet(session string) bool {
	deadline := time.Now().Add(exitWait)
	for {
		r.mu.Lock()
		t := r.turns[session]
		r.mu.Unlock()
		if t == nil {
			return true
		}
		if !t.closing || time.Now().After(deadline) {
			return false
		}
		select {
		case <-t.exited:
		case <-time.After(time.Until(deadline)):
		}
	}
}

func (r *runner) run(t *turn, proc process, msg agent.Message) {
	s := t.session
	sendErr := proc.Send(msg)
	if sendErr != nil {
		// Reported when the exit event arrives below.
		log.Printf("session %s: send: %v", s, sendErr)
		proc.Close()
	}
	for ev := range proc.Events() {
		switch ev.Kind {
		case agent.KindInit:
			// Each turn starts with one: the one sent, or one the CLI starts
			// itself when a background task ends or a monitor prints.
			r.mu.Lock()
			t.open, t.held = true, false
			t.inits++
			t.model = ev.Model
			r.takeSlot(t)
			idle, stop := t.idle, t.stopNext
			t.stopNext = false
			r.mu.Unlock()
			r.hub.publish(Ev{Type: "turn", Session: s, State: "running", Idle: idle})
			if stop {
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), controlWait)
					defer cancel()
					if err := proc.Interrupt(ctx); err != nil {
						log.Printf("session %s: the stop asked for during the start: %v", s, err)
					}
				}()
			}
		case agent.KindTasks:
			r.mu.Lock()
			t.tasks = ev.Tasks
			linger := t.held && len(t.tasks) == 0
			r.mu.Unlock()
			r.hub.publish(Ev{Type: "tasks", Session: s, Tasks: ev.Tasks})
			if linger {
				go r.closeIfIdle(t, proc)
			}
		case agent.KindTextDelta, agent.KindThinkingDelta:
			if ev.ParentToolUseID != "" {
				continue // inside a subagent; its rows arrive as tool results
			}
			kind := "text"
			if ev.Kind == agent.KindThinkingDelta {
				kind = "thinking"
			}
			r.hub.publish(Ev{Type: "delta", Session: s, Index: ev.Index, Kind: kind, Text: ev.Text})
		case agent.KindAssistant, agent.KindUser:
			e := Ev{Type: "appended", Session: s, Kind: string(ev.Kind), UUID: ev.UUID}
			if ev.Replay {
				e.PromptID = t.promptID
				r.mu.Lock()
				t.unechoed = false
				r.mu.Unlock()
			}
			r.hub.publish(e)
		case agent.KindPermission:
			p := ev.Permission
			r.mu.Lock()
			t.perms[p.ID] = true
			r.mu.Unlock()
			r.hub.publish(Ev{Type: "permission", Session: s, Permission: &Permission{
				ID: p.ID, Tool: p.Tool, Input: p.Input, Description: p.Description,
				Reason: p.Reason, BlockedPath: p.BlockedPath,
			}})
		case agent.KindPermissionCancel:
			if r.takePermission(t, ev.RequestID) {
				r.hub.publish(Ev{Type: "permissionDone", Session: s, RequestID: ev.RequestID, Decision: "cancelled"})
			}
		case agent.KindResult:
			res := ev.Result
			result := &Result{
				OK: res.OK, Interrupted: res.Interrupted, Text: res.Text, Errors: res.Errors,
				Reason: res.TerminalReason, CostUSD: res.CostUSD, Usage: res.Usage, SignIn: res.SignedOut,
			}
			r.mu.Lock()
			result.Model = t.model
			result.ContextWindow = mainWindow(res.ContextWindows, t.model)
			if t.unechoed && res.OK && !res.Interrupted {
				// Not the sent prompt's result: the CLI has not taken it up
				// yet. Either a wake-up turn that began just before the send
				// reached it (its prompt waits in the CLI's queue), or a
				// resumed session answering a stopped task's queued notice
				// with an empty result first (BRIEF, "Background tasks").
				// The sent turn stays open and the process stays; a wake-up
				// still gets its done. settle catches a prompt that never runs.
				inits := t.inits
				r.mu.Unlock()
				if res.NumTurns > 0 || res.Text != "" {
					r.hub.publish(Ev{Type: "turn", Session: s, State: "done", Result: result})
				}
				go r.settle(t, proc, inits)
				continue
			}
			t.open, t.unechoed = false, false
			keep := r.holdOrClose(t)
			idle := t.idle
			t.idle = false // a wake-up turn after it is not housekeeping
			r.mu.Unlock()
			r.hub.publish(Ev{Type: "turn", Session: s, State: "done", Result: result, Idle: idle})
			if !keep {
				go proc.Close() // per-turn process; the exit event follows
			} else {
				go r.drain(s) // the held process takes the next queued message
			}
		case agent.KindExit:
			r.mu.Lock()
			open, hadTasks, idle := t.open, len(t.tasks) > 0, t.idle
			t.open, t.held, t.tasks = false, false, nil
			r.mu.Unlock()
			if open {
				msg := "the CLI exited without finishing the turn"
				if sendErr != nil {
					msg = "sending the prompt to the CLI failed: " + sendErr.Error()
				} else if ev.Err != nil {
					msg += ": " + ev.Err.Error()
				}
				r.hub.publish(Ev{Type: "turn", Session: s, State: "done", Error: msg, Idle: idle})
			}
			if hadTasks {
				r.hub.publish(Ev{Type: "tasks", Session: s, Tasks: []agent.Task{}})
			}
		}
	}
	// Refresh the index before freeing the session. During the turn the
	// index recorded this process as holding the session; once released,
	// the runner no longer counts that pid as its own, and a send arriving
	// before the refresh would be refused as held by another process.
	r.onEnd()
	r.release(t, false)
	r.noteLeftovers(t.session)
	r.drain(t.session) // the next queued message, in a process of its own
}

// holdOrClose ends a turn's run: the process is held while it has
// background tasks (giving its slot back), else marked closing; it says
// which. Called with mu held.
func (r *runner) holdOrClose(t *turn) (keep bool) {
	keep = len(t.tasks) > 0 && !r.stopped
	if keep {
		t.held = true
		r.dropSlot(t)
	} else {
		t.closing = true
	}
	return keep
}

// settle ends a sent turn whose prompt the CLI never took up: no turn has
// started since a result that was not its own (see KindResult in run).
// Without it the session would show running forever.
func (r *runner) settle(t *turn, proc process, inits int) {
	time.Sleep(heldLinger)
	r.mu.Lock()
	stale := t.unechoed && t.open && t.inits == inits && !t.closing
	keep := false
	if stale {
		t.open, t.unechoed = false, false
		keep = r.holdOrClose(t)
	}
	r.mu.Unlock()
	if !stale {
		return
	}
	log.Printf("session %s: the CLI did not take up the prompt", t.session)
	r.hub.publish(Ev{Type: "turn", Session: t.session, State: "done", Error: "the CLI did not take up the prompt; send it again"})
	if !keep {
		proc.Close()
	}
}

// closeIfIdle closes a held process whose tasks are all gone, if no turn
// has started in it meanwhile (the CLI normally wakes once more to say the
// last task ended, and that turn's result closes it instead).
func (r *runner) closeIfIdle(t *turn, proc process) {
	time.Sleep(heldLinger)
	r.mu.Lock()
	idle := t.held && !t.open && len(t.tasks) == 0
	if idle {
		t.held, t.closing = false, true
	}
	r.mu.Unlock()
	if idle {
		proc.Close()
	}
}

// stopTask stops one background task of the session's process.
func (r *runner) stopTask(session, task string) error {
	r.mu.Lock()
	t := r.turns[session]
	var proc process
	if t != nil && !t.closing {
		for _, k := range t.tasks {
			if k.ID == task {
				proc = t.proc
			}
		}
	}
	r.mu.Unlock()
	stopper, ok := proc.(taskStopper)
	if !ok {
		return &httpError{status: 409, msg: "no such background task (it may have ended)"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), controlWait)
	defer cancel()
	if err := stopper.StopTask(ctx, task); err != nil {
		return &httpError{status: 502, msg: "stopping the task: " + err.Error()}
	}
	// A stop wakes no turn, so a held process with nothing else running
	// has nothing left to wait for.
	r.mu.Lock()
	last := t.held && !t.open && (len(t.tasks) == 0 || len(t.tasks) == 1 && t.tasks[0].ID == task)
	if last {
		t.held, t.closing = false, true
	}
	r.mu.Unlock()
	if last {
		go proc.Close()
	}
	return nil
}

func (r *runner) takePermission(t *turn, id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !t.perms[id] {
		return false
	}
	delete(t.perms, id)
	return true
}

// answer allows or denies a pending permission. The first answer wins; a
// second, from another device, gets 409.
func (r *runner) answer(session, requestID string, allow bool, message string) error {
	r.mu.Lock()
	t := r.turns[session]
	var proc process
	if t != nil && t.proc != nil && t.perms[requestID] {
		proc = t.proc
		delete(t.perms, requestID) // first answer wins
	}
	r.mu.Unlock()
	if proc == nil {
		return &httpError{status: 409, msg: "no such pending permission (already answered or withdrawn)"}
	}
	var err error
	decision := "allow"
	if allow {
		err = proc.Allow(requestID, nil)
	} else {
		decision = "deny"
		if message == "" {
			message = "The user declined."
		}
		err = proc.Deny(requestID, message)
	}
	if err != nil {
		// The CLI withdrew the request (or exited) just before this
		// answer. Its cancel event will find the id already taken, so
		// say it here, or every screen keeps the prompt open.
		r.hub.publish(Ev{Type: "permissionDone", Session: session, RequestID: requestID, Decision: "cancelled"})
		return &httpError{status: 409, msg: err.Error()}
	}
	r.hub.publish(Ev{Type: "permissionDone", Session: session, RequestID: requestID, Decision: decision})
	return nil
}

// interrupt stops the session's turn. A stop that comes while the turn is
// still starting (the process not yet up, or up but not yet at the
// prompt: Codex has no turn id to name before then) is kept and sent the
// moment the CLI announces the turn, so a tap during "Starting…" counts.
func (r *runner) interrupt(session string) error {
	r.mu.Lock()
	t := r.turns[session]
	var proc process
	if t != nil && !t.closing && !t.held && t.open {
		if t.proc == nil || t.unechoed && t.inits == 0 {
			t.stopNext = true
			r.mu.Unlock()
			return nil
		}
		proc = t.proc
	}
	r.mu.Unlock()
	if proc == nil {
		return &httpError{status: 409, msg: "no turn is running in this session"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := proc.Interrupt(ctx); err != nil {
		return &httpError{status: 502, msg: "interrupt: " + err.Error()}
	}
	return nil
}

// stop refuses new turns and closes the running ones. Background tasks are
// stopped first: on a closed input the CLI waits for them, and the kill
// after the grace period would leave their commands running unwatched.
func (r *runner) stop() {
	r.mu.Lock()
	r.stopped = true
	type live struct {
		proc  process
		tasks []agent.Task
	}
	var procs []live
	var waits []chan struct{}
	for _, t := range r.turns {
		if t.proc != nil {
			procs = append(procs, live{t.proc, t.tasks})
			if len(t.tasks) > 0 {
				log.Printf("session %s: stopping %d background task(s) to shut down", t.session, len(t.tasks))
			}
		}
		waits = append(waits, t.exited)
	}
	r.mu.Unlock()
	for _, p := range procs {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), controlWait)
			defer cancel()
			if stopper, ok := p.proc.(taskStopper); ok {
				for _, k := range p.tasks {
					stopper.StopTask(ctx, k.ID)
				}
			}
			p.proc.Close()
		}()
	}
	for _, w := range waits {
		<-w
	}
}

func newUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func asHTTPError(err error) *httpError {
	var he *httpError
	if errors.As(err, &he) {
		return he
	}
	return &httpError{status: 500, msg: err.Error()}
}

// mainWindow picks the turn's own model's context window out of what the
// CLI reported per model (a subagent on another model adds an entry): the
// model by name (a "[1m]" suffix aside), else the only entry. 0 if unsure.
func mainWindow(w map[string]int, model string) int {
	if n, ok := w[model]; ok {
		return n
	}
	base := strings.TrimSuffix(model, "[1m]")
	for m, n := range w {
		if strings.TrimSuffix(m, "[1m]") == base {
			return n
		}
	}
	if len(w) == 1 {
		for _, n := range w {
			return n
		}
	}
	return 0
}
