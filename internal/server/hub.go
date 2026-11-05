package server

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/agent"
	"github.com/dakort-app/dakort/internal/procs"
)

// Ev is one event on the stream. Every event carries its type; the other
// fields depend on it.
//
//	sessions        the session list changed; refetch it (and the folders)
//	folders         a folder was opened or closed; refetch the folders
//	ping            every 15 s, not numbered, so the browser can tell a dead stream
//	turn            State starting | running | done; done carries Result or Error
//	delta           Index, Kind (text | thinking), Text: live preview of a block
//	appended        Kind (user | assistant), UUID: a row reached the transcript;
//	                catch up with rows?after=. PromptID marks the echo of a sent prompt.
//	                No Kind or UUID: the file grew outside our turns (another Claude).
//	permission      Permission: the CLI asks before running a tool
//	permissionDone  RequestID, Decision allow | deny | cancelled
//	tasks           Tasks: the session's background tasks now (empty: none left)
//	queue           Queue: the session's messages waiting for its turn to end (queue.go)
//	leftovers       Leftovers: processes the session's last turn left running (leftovers.go)
//	release         Latest: a newer release's tag (release.go)
//	snapshot        Turns: every running turn's partial blocks and pending
//	                permissions. Background: each session's background tasks.
//	                Queues: each session's queued messages. AllLeftovers: each
//	                session's leftover processes.
//	                Gap: events were missed; re-page open transcripts.
type Ev struct {
	Type         string                  `json:"type"`
	Session      string                  `json:"session,omitempty"`
	PromptID     string                  `json:"promptId,omitempty"`
	State        string                  `json:"state,omitempty"`
	Index        int                     `json:"index,omitempty"`
	Kind         string                  `json:"kind,omitempty"`
	Text         string                  `json:"text,omitempty"`
	UUID         string                  `json:"uuid,omitempty"`
	Permission   *Permission             `json:"permission,omitempty"`
	RequestID    string                  `json:"requestId,omitempty"`
	Decision     string                  `json:"decision,omitempty"`
	Result       *Result                 `json:"result,omitempty"`
	Error        string                  `json:"error,omitempty"`
	Turns        []LiveTurn              `json:"turns,omitempty"`
	Tasks        []agent.Task            `json:"tasks,omitempty"`
	Background   map[string][]agent.Task `json:"background,omitempty"`
	Gap          bool                    `json:"gap,omitempty"`
	Idle         bool                    `json:"idle,omitempty"`         // turn: housekeeping the server ran (an idle compaction, a rename), not a reply to announce
	Queue        []Queued                `json:"queue,omitempty"`        // queue: the session's queued messages now (none: empty)
	Queues       map[string][]Queued     `json:"queues,omitempty"`       // snapshot: every session's
	Leftovers    []procs.Info            `json:"leftovers,omitempty"`    // leftovers: what the session's last turn left running (none: empty)
	AllLeftovers map[string][]procs.Info `json:"allLeftovers,omitempty"` // snapshot: every session's
	Folder       string                  `json:"folder,omitempty"`       // tabs: the folder whose open tabs changed (tabs.go)
	Tabs         []string                `json:"tabs,omitempty"`         // tabs: its open tabs now (none: empty)
	Build        string                  `json:"build,omitempty"`        // snapshot: the server's version; a page loaded from another build reloads once hidden
	Latest       string                  `json:"latest,omitempty"`       // release, snapshot: a newer release's tag (release.go)
}

type Permission struct {
	ID          string          `json:"id"`
	Tool        string          `json:"tool"`
	Input       json.RawMessage `json:"input,omitempty"`
	Description string          `json:"description,omitempty"`
	Reason      string          `json:"reason,omitempty"`
	BlockedPath string          `json:"blockedPath,omitempty"`
}

type Result struct {
	OK          bool            `json:"ok"`
	Interrupted bool            `json:"interrupted,omitempty"`
	Text        string          `json:"text,omitempty"`
	Errors      []string        `json:"errors,omitempty"`
	Reason      string          `json:"reason,omitempty"` // the CLI's terminal_reason
	CostUSD     float64         `json:"costUsd,omitempty"`
	Usage       json.RawMessage `json:"usage,omitempty"`
	// The turn's model and its context window as the CLI reported it
	// (contextWindow 0: it did not say), for the composer's context bar.
	Model         string `json:"model,omitempty"`
	ContextWindow int    `json:"contextWindow,omitempty"`
	SignIn        bool   `json:"signIn,omitempty"` // failed as the CLI is not signed in
}

// LiveTurn is what a viewer arriving mid-turn needs: the parts of the
// reply not yet in the transcript, and the questions waiting for an answer.
type LiveTurn struct {
	Session     string         `json:"session"`
	PromptID    string         `json:"promptId,omitempty"`
	State       string         `json:"state"`
	Blocks      map[int]*Block `json:"blocks,omitempty"`
	Permissions []*Permission  `json:"permissions,omitempty"`
}

type Block struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// event is an Ev as sent: its id and encoded form.
type event struct {
	seq  uint64
	id   string
	data []byte
}

// At least ringSize events are kept for replay. A long reply is a thousand
// or two deltas, so this covers a phone asleep through a turn or two;
// beyond it the viewer gets a gap snapshot instead.
const ringSize = 4096

// subQueue events may wait for a slow viewer before it is cut off; its
// browser reconnects and replays from the ring.
const subQueue = 1024

type sub struct{ ch chan event }

// hub numbers events, keeps the recent ones for replay, fans them out, and
// folds them into the live state, all under one lock, so a snapshot and
// the events after it never overlap or leave a hole.
type hub struct {
	epoch string // ids from an earlier server run never match

	mu    sync.Mutex
	seq   uint64
	ring  []event
	subs  map[*sub]struct{}
	live  map[string]*LiveTurn    // by session
	tasks map[string][]agent.Task // by session; outlives the turns
	queue map[string][]Queued     // by session
	left  map[string][]procs.Info // by session
	build string                  // the server's version, in every snapshot: a page from an older build reloads itself
	latest string                 // a newer release's tag, once found (release.go), in every snapshot
}

func newHub() *hub {
	return &hub{
		epoch: strconv.FormatInt(time.Now().UnixNano(), 36),
		subs:  map[*sub]struct{}{},
		live:  map[string]*LiveTurn{},
		tasks: map[string][]agent.Task{},
		queue: map[string][]Queued{},
		left:  map[string][]procs.Info{},
	}
}

func (h *hub) publish(e Ev) {
	data, err := json.Marshal(e)
	if err != nil {
		panic(err) // Ev has no field that can fail to encode
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.apply(e)
	h.seq++
	ev := event{seq: h.seq, id: fmt.Sprintf("%s-%d", h.epoch, h.seq), data: data}
	if len(h.ring) == 2*ringSize {
		// Trim in halves, not one event at a time: the ring holds
		// between ringSize and twice that.
		h.ring = append([]event(nil), h.ring[ringSize:]...)
	}
	h.ring = append(h.ring, ev)
	for s := range h.subs {
		select {
		case s.ch <- ev:
		default:
			// Too slow: end its stream rather than stall everyone.
			close(s.ch)
			delete(h.subs, s)
		}
	}
}

// apply folds an event into the live state. Called with mu held.
func (h *hub) apply(e Ev) {
	t := h.live[e.Session]
	switch e.Type {
	case "tasks":
		if len(e.Tasks) == 0 {
			delete(h.tasks, e.Session)
		} else {
			h.tasks[e.Session] = e.Tasks
		}
	case "queue":
		if len(e.Queue) == 0 {
			delete(h.queue, e.Session)
		} else {
			h.queue[e.Session] = e.Queue
		}
	case "leftovers":
		if len(e.Leftovers) == 0 {
			delete(h.left, e.Session)
		} else {
			h.left[e.Session] = e.Leftovers
		}
	case "turn":
		if e.State == "done" {
			delete(h.live, e.Session)
			return
		}
		if t == nil {
			t = &LiveTurn{Session: e.Session, Blocks: map[int]*Block{}}
			h.live[e.Session] = t
		}
		t.State = e.State
		if e.PromptID != "" {
			t.PromptID = e.PromptID
		}
	case "delta":
		if t == nil {
			return
		}
		b := t.Blocks[e.Index]
		if b == nil {
			b = &Block{Kind: e.Kind}
			t.Blocks[e.Index] = b
		}
		b.Text += e.Text
	case "appended":
		// A complete assistant block is in the transcript now; the
		// partial copies are stale.
		if t != nil && e.Kind == "assistant" {
			t.Blocks = map[int]*Block{}
		}
	case "permission":
		if t != nil {
			t.Permissions = append(t.Permissions, e.Permission)
		}
	case "permissionDone":
		if t != nil {
			for i, p := range t.Permissions {
				if p.ID == e.RequestID {
					t.Permissions = append(t.Permissions[:i], t.Permissions[i+1:]...)
					break
				}
			}
		}
	}
}

// subscribe registers a viewer that last saw event id last (empty for a
// fresh one). It returns the events to replay or, when there is nothing to
// replay from, a snapshot to send first. The snapshot's Gap is set when the
// viewer had seen events that are no longer in the ring, or came from an
// earlier server run.
func (h *hub) subscribe(last string) (s *sub, replay []event, snap *event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s = &sub{ch: make(chan event, subQueue)}
	h.subs[s] = struct{}{}
	if last != "" {
		if seq, ok := h.parseID(last); ok && seq <= h.seq {
			oldest := h.seq - uint64(len(h.ring)) // the ring holds oldest+1 .. seq
			if seq >= oldest {
				return s, append([]event(nil), h.ring[seq-oldest:]...), nil
			}
		}
	}
	turns := make([]LiveTurn, 0, len(h.live))
	for _, t := range h.live {
		c := *t
		c.Blocks = map[int]*Block{}
		for i, b := range t.Blocks {
			bc := *b
			c.Blocks[i] = &bc
		}
		c.Permissions = append([]*Permission(nil), t.Permissions...)
		turns = append(turns, c)
	}
	bg := map[string][]agent.Task{}
	for s, l := range h.tasks {
		bg[s] = l
	}
	qs := map[string][]Queued{}
	for s, q := range h.queue {
		qs[s] = q
	}
	left := map[string][]procs.Info{}
	for s, l := range h.left {
		left[s] = l
	}
	data, _ := json.Marshal(Ev{Type: "snapshot", Turns: turns, Background: bg, Queues: qs, AllLeftovers: left, Gap: last != "", Build: h.build, Latest: h.latest})
	return s, nil, &event{seq: h.seq, id: fmt.Sprintf("%s-%d", h.epoch, h.seq), data: data}
}

func (h *hub) unsubscribe(s *sub) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[s]; ok {
		close(s.ch)
		delete(h.subs, s)
	}
}

func (h *hub) watched() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs) > 0
}

func (h *hub) parseID(id string) (uint64, bool) {
	epoch, n, ok := strings.Cut(id, "-")
	if !ok || epoch != h.epoch {
		return 0, false
	}
	seq, err := strconv.ParseUint(n, 10, 64)
	return seq, err == nil
}
