// Package index lists Claude Code sessions from ~/.claude/projects and keeps
// the list current by polling. A poll stats every transcript (a few ms for a
// hundred files) and re-reads only the files whose size or mtime changed.
// There is no database: the files are the truth and the index is rebuilt
// in memory on start.
//
// What a session's entry is made of, and why (measured 2026-10-22, see the
// NOTES in BRIEF.md):
//   - Title, cwd and created time come from the head of the file. The cwd is
//     the first row's, since sessions change directory as they go.
//   - Updated is the last user or assistant row's time, from the tail. The
//     file's mtime is not used for this: the CLI appends bookkeeping lines
//     long after the last row.
//   - Held marks a session a live CLI process has open, from the registry
//     in ~/.claude/sessions, which keeps stale files for dead processes.
package index

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dakort-app/dakort/internal/transcript"
)

type Session struct {
	ID       string    `json:"id"`
	Provider string    `json:"provider"` // "claude"; Codex comes later
	Title    string    `json:"title"`
	Cwd      string    `json:"cwd"`     // empty when the file has no row yet
	Project  string    `json:"project"` // folder name under the projects root
	Created  time.Time `json:"created"`
	Updated  time.Time `json:"updated"` // last user or assistant row; mtime when there is none
	Size     int64     `json:"size"`
	HeldBy   int       `json:"heldBy,omitempty"` // pid of a live CLI that has the session open
	// Used is the model and permission mode the session last ran with, so
	// continuing it elsewhere keeps them instead of the global defaults.
	Used transcript.Used `json:"used,omitzero"`
	Path string          `json:"-"`
}

// headMax caps the head scan. Every file with a title source on this
// laptop had one within 1 MB.
const headMax = 1 << 20

// workers read changed files in parallel. Four is within 20 ms of eight on
// a full rebuild, and a poll rarely has more than one file to read.
const workers = 4

const maxTitle = 120

// usedMax caps the backward read for what a session last ran with, on a
// file's first read. Old sessions (before the CLI recorded the mode) would
// otherwise be read whole.
const usedMax = 4 << 20

type Index struct {
	Root     string // ~/.claude/projects
	Registry string // ~/.claude/sessions
	// Codex threads: the rollouts under ~/.codex/sessions, and the CLI's
	// own index beside them, which holds the names it gives threads.
	// Both empty: no Codex.
	CodexRoot  string
	CodexIndex string

	refreshMu sync.Mutex // one Refresh at a time
	mu        sync.Mutex
	files     map[string]*entry // by path

	names      map[string]string // Codex thread names by id, from CodexIndex
	namesMTime time.Time
	namesSize  int64

	moved func(cwd string, created time.Time) string // SetMoved
}

// SetMoved gives the index the folder renames to apply: a session keeps
// the cwd its file records, which names the folder as it was when the
// session began, and moved says where that folder is now.
func (x *Index) SetMoved(f func(cwd string, created time.Time) string) {
	x.mu.Lock()
	x.moved = f
	x.mu.Unlock()
}

// view is an entry as listed, its cwd moved. Called with mu held.
func (x *Index) view(e *entry) Session {
	s := e.s
	if x.moved != nil && s.Cwd != "" {
		s.Cwd = x.moved(s.Cwd, s.Created)
	}
	return s
}

type entry struct {
	s       Session
	mtime   time.Time
	aiTitle bool // the title came from the CLI; no need to read the head again
	// A Codex subagent thread (a guardian review): kept, so its file is not
	// read again on every poll, but never listed. As a session of its own it
	// once took the folder's newest spot and its tabs with it.
	helper bool
}

func New() *Index {
	home, _ := os.UserHomeDir()
	return &Index{
		Root:       transcript.ProjectsRoot(),
		Registry:   filepath.Join(home, ".claude", "sessions"),
		CodexRoot:  transcript.CodexSessionsRoot(),
		CodexIndex: transcript.CodexIndexFile(),
	}
}

// List returns the sessions, most recently active first.
func (x *Index) List() []Session {
	x.mu.Lock()
	out := make([]Session, 0, len(x.files))
	for _, e := range x.files {
		if !e.helper {
			out = append(out, x.view(e))
		}
	}
	x.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Updated.Equal(out[j].Updated) {
			return out[i].Updated.After(out[j].Updated)
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// Get finds a session by id.
func (x *Index) Get(id string) (Session, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	for _, e := range x.files {
		if e.s.ID == id && !e.helper {
			return x.view(e), true
		}
	}
	return Session{}, false
}

type stat struct {
	path, project string
	provider      string // "claude" or "codex"
	size          int64
	mtime         time.Time
}

// Refresh brings the index up to date and reports whether the list changed.
func (x *Index) Refresh() (bool, error) {
	x.refreshMu.Lock()
	defer x.refreshMu.Unlock()

	found, err := x.walk()
	if err != nil {
		return false, err
	}
	x.mu.Lock()
	old := x.files
	x.mu.Unlock()

	// Work out what to read before taking the lock again, so List never
	// waits on disk.
	var todo []stat
	for _, st := range found {
		e := old[st.path]
		if e == nil || e.s.Size != st.size || !e.mtime.Equal(st.mtime) {
			todo = append(todo, st)
		}
	}
	read := make([]*entry, len(todo))
	var wg sync.WaitGroup
	next := make(chan int)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				read[i] = load(todo[i], old[todo[i].path])
			}
		}()
	}
	for i := range todo {
		next <- i
	}
	close(next)
	wg.Wait()

	files := make(map[string]*entry, len(found))
	for _, st := range found {
		if e := old[st.path]; e != nil {
			files[st.path] = e
		}
	}
	changed := len(todo) > 0
	for i, st := range todo {
		if read[i] != nil {
			files[st.path] = read[i]
		} else {
			delete(files, st.path) // gone between the walk and the read
		}
	}
	if len(files) != len(old) {
		changed = true // a file disappeared
	}
	held := readRegistry(x.Registry)
	names := x.readNames()
	for path, e := range files {
		if pid := held[e.s.ID]; pid != e.s.HeldBy {
			c := *e // entries are shared with the previous map; copy, never mutate
			c.s.HeldBy = pid
			files[path] = &c
			changed = true
		}
		// Codex names a thread after its first turn and renames on request;
		// the name lives in the CLI's index, not the rollout.
		if name := names[e.s.ID]; name != "" && e.s.Provider == "codex" && e.s.Title != name {
			c := *e
			c.s.Title = name
			files[path] = &c
			changed = true
		}
	}
	x.mu.Lock()
	x.files = files
	x.mu.Unlock()
	return changed, nil
}

// readNames keeps the Codex thread names current, rereading the CLI's
// session_index.jsonl ({id, thread_name, updated_at} per line, the last
// line for an id counts) only when the file changed.
func (x *Index) readNames() map[string]string {
	if x.CodexIndex == "" {
		return nil
	}
	fi, err := os.Stat(x.CodexIndex)
	if err != nil {
		return x.names
	}
	if x.names != nil && fi.ModTime().Equal(x.namesMTime) && fi.Size() == x.namesSize {
		return x.names
	}
	data, err := os.ReadFile(x.CodexIndex)
	if err != nil {
		return x.names
	}
	names := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		var r struct {
			ID   string `json:"id"`
			Name string `json:"thread_name"`
		}
		if json.Unmarshal([]byte(line), &r) == nil && r.ID != "" && strings.TrimSpace(r.Name) != "" {
			names[r.ID] = strings.Join(strings.Fields(r.Name), " ")
		}
	}
	x.names, x.namesMTime, x.namesSize = names, fi.ModTime(), fi.Size()
	return names
}

// walk stats the top-level transcripts of every project folder. Subagent
// transcripts live one level deeper, under <session>/subagents/, and are
// not sessions of their own. Codex rollouts sit three folders down
// (year, month, day) under their own root.
func (x *Index) walk() ([]stat, error) {
	var out []stat
	if x.CodexRoot != "" {
		paths, _ := filepath.Glob(filepath.Join(x.CodexRoot, "*", "*", "*", "rollout-*.jsonl"))
		for _, path := range paths {
			if _, ok := transcript.IsRollout(filepath.Base(path)); !ok {
				continue
			}
			fi, err := os.Stat(path)
			if err != nil || !fi.Mode().IsRegular() {
				continue
			}
			out = append(out, stat{path: path, provider: "codex", size: fi.Size(), mtime: fi.ModTime()})
		}
	}
	projects, err := os.ReadDir(x.Root)
	if errors.Is(err, fs.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	for _, p := range projects {
		if !p.IsDir() {
			continue
		}
		dir := filepath.Join(x.Root, p.Name())
		names, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, n := range names {
			if n.IsDir() || !strings.HasSuffix(n.Name(), ".jsonl") {
				continue
			}
			path := filepath.Join(dir, n.Name())
			// os.Stat rather than the directory entry's info: it reads
			// the file itself, and saw every append of a file another
			// process held open.
			fi, err := os.Stat(path)
			if err != nil || !fi.Mode().IsRegular() {
				continue
			}
			out = append(out, stat{path: path, project: p.Name(), provider: "claude", size: fi.Size(), mtime: fi.ModTime()})
		}
	}
	return out, nil
}

// load reads a new or changed file. The head is read again only when the
// file is new, shrank, or has no CLI title yet; the first ai-title is kept
// for good (later ones differ only cosmetically).
func load(st stat, old *entry) *entry {
	if st.provider == "codex" {
		return loadCodex(st, old)
	}
	e := &entry{mtime: st.mtime}
	if old != nil && old.aiTitle && st.size >= old.s.Size {
		e.s, e.aiTitle = old.s, true
	} else {
		info, err := transcript.Head(st.path, headMax)
		if err != nil {
			return nil
		}
		e.aiTitle = info.AITitle != ""
		e.s = Session{
			ID:       strings.TrimSuffix(filepath.Base(st.path), ".jsonl"),
			Provider: "claude",
			Title:    title(info, st.project),
			Cwd:      info.Cwd,
			Project:  st.project,
			Created:  info.First,
			Path:     st.path,
		}
		if old != nil {
			e.s.HeldBy = old.s.HeldBy
		}
	}
	last, err := transcript.LastActivity(st.path)
	if err != nil {
		return nil
	}
	if last.IsZero() {
		last = st.mtime
	}
	// A grown file: only the new part can change what ran last.
	if old != nil && old.s.Size > 0 && st.size >= old.s.Size {
		e.s.Used, err = transcript.UsedSince(st.path, old.s.Size, old.s.Used)
	} else {
		e.s.Used, err = transcript.LastUsed(st.path, usedMax)
	}
	if err != nil {
		return nil
	}
	// A name given with /rename (from here, a terminal, VS Code) beats
	// the CLI's own title.
	if e.s.Used.Title != "" {
		e.s.Title = e.s.Used.Title
	}
	e.s.Updated, e.s.Size = last, st.size
	if e.s.Created.IsZero() {
		e.s.Created = last
	}
	return e
}

// loadCodex is load for a rollout. The head (the thread id and cwd) is
// read once; the name Codex gives the thread comes from its index, in
// Refresh. The turn_context of the last turn says what it ran with.
func loadCodex(st stat, old *entry) *entry {
	e := &entry{mtime: st.mtime}
	if old != nil && st.size >= old.s.Size {
		e.s, e.helper = old.s, old.helper
	} else {
		info, err := transcript.CodexHead(st.path, headMax)
		if err != nil {
			return nil
		}
		e.helper = info.Subagent
		if info.SessionID == "" {
			info.SessionID, _ = transcript.IsRollout(filepath.Base(st.path))
		}
		e.s = Session{
			ID:       info.SessionID,
			Provider: "codex",
			Title:    title(info, "codex"),
			Cwd:      info.Cwd,
			Created:  info.First,
			Path:     st.path,
		}
	}
	last, err := transcript.CodexLastActivity(st.path)
	if err != nil {
		return nil
	}
	if last.IsZero() {
		last = st.mtime
	}
	if e.s.Used, err = transcript.CodexLastUsed(st.path, usedMax); err != nil {
		return nil
	}
	e.s.Updated, e.s.Size = last, st.size
	if e.s.Created.IsZero() {
		e.s.Created = last
	}
	return e
}

// title prefers the CLI's own title, then an old summary row, then the
// first prompt, then the folder the session ran in.
func title(info transcript.Info, project string) string {
	t := info.AITitle
	if t == "" {
		t = info.Summary
	}
	if t == "" {
		t = info.FirstPrompt
	}
	if t == "" && info.Cwd != "" {
		t = filepath.Base(strings.ReplaceAll(info.Cwd, `\`, "/"))
	}
	if t == "" {
		t = project
	}
	t = strings.Join(strings.Fields(t), " ")
	if utf8.RuneCountInString(t) > maxTitle {
		r := []rune(t)
		t = string(r[:maxTitle-1]) + "…"
	}
	return t
}

// readRegistry maps session id to the pid of a live CLI holding it. Every
// running CLI writes <pid>.json there and removes it on exit, but a crash
// or reboot leaves the file behind, so each pid is checked.
func readRegistry(dir string) map[string]int {
	paths, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	held := map[string]int{}
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var r struct {
			PID       int    `json:"pid"`
			SessionID string `json:"sessionId"`
			ProcStart string `json:"procStart"`
		}
		if json.Unmarshal(data, &r) != nil || r.PID <= 0 || r.SessionID == "" {
			continue
		}
		if alive(r.PID, r.ProcStart) {
			held[r.SessionID] = r.PID
		}
	}
	return held
}
