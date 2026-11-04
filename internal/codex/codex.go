// Package codex drives the Codex CLI through its app-server: JSON-RPC over
// stdio, one process per turn like the Claude relay. The exec mode
// (codex exec --json) has no streaming, no approvals and no interrupt, and
// took 15 s for a one-word answer against the app-server's 6 s (measured
// 2026-10-28, codex 0.163; BRIEF "Codex app-server").
//
// A process starts or resumes one thread; Send runs one turn in it. The
// server asks us to approve commands and edits as requests of its own,
// answered by Allow and Deny.
package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dakort-app/dakort/internal/agent"
)

type Options struct {
	Bin string // path to codex; FindBinary() when empty
	Cwd string

	Resume string // thread id to resume; a new thread when empty

	Model  string // gpt-5.6-sol, ...; the CLI's default when empty
	Effort string // low, medium, high, xhigh, max, ultra
	// PermissionMode is the picker's name (manual, auto, plan,
	// bypassPermissions, dontAsk) for an approval policy and sandbox
	// pair; see Policy.
	PermissionMode string

	Env []string // added to the inherited environment

	// CloseGrace is how long Close waits for a clean exit before killing.
	CloseGrace time.Duration
}

// FindBinary looks for codex. The npm install puts a script on PATH that
// starts node to start the real program; the program itself is used when
// it can be found beside the script, so a kill reaches it and stdio has
// one hop fewer. The desktop app's copy is the last resort.
func FindBinary() (string, error) {
	p, err := exec.LookPath("codex")
	if err == nil {
		if real := vendored(p); real != "" {
			return real, nil
		}
		return p, nil
	}
	if runtime.GOOS == "windows" {
		matches, _ := filepath.Glob(filepath.Join(os.Getenv("LOCALAPPDATA"), "OpenAI", "Codex", "bin", "*", "codex.exe"))
		if len(matches) > 0 {
			return matches[len(matches)-1], nil
		}
	}
	return "", errors.New("codex not found on PATH")
}

func vendored(script string) string {
	ext := strings.ToLower(filepath.Ext(script))
	if ext != ".cmd" && ext != ".ps1" && ext != "" {
		return ""
	}
	pattern := filepath.Join(filepath.Dir(script), "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-*", "vendor", "*", "codex", "codex")
	if runtime.GOOS == "windows" {
		pattern = filepath.Join(filepath.Dir(script), "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-*", "vendor", "*", "bin", "codex.exe")
	}
	matches, _ := filepath.Glob(pattern)
	for _, m := range matches {
		if fi, err := os.Stat(m); err == nil && fi.Mode().IsRegular() {
			return m
		}
	}
	return ""
}

// Policy is the approval policy, sandbox and reviewer a permission mode
// stands for (the reverse of transcript.CodexMode). The picker's names
// are Claude's, one list for both providers: manual asks before anything
// outside the workspace sandbox, auto lets Codex's own reviewer decide,
// plan is a read-only sandbox, bypassPermissions no sandbox and no
// questions, dontAsk the sandbox with no questions.
func Policy(mode string) (approval, sandbox, reviewer string) {
	switch mode {
	case "bypassPermissions":
		return "never", "danger-full-access", "user"
	case "dontAsk":
		return "never", "workspace-write", "user"
	case "plan":
		return "on-request", "read-only", "user"
	case "auto":
		return "on-request", "workspace-write", "auto_review"
	}
	return "on-request", "workspace-write", "user"
}

type rpcMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type Process struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	grace time.Duration
	opts  Options

	writeMu sync.Mutex
	closed  bool

	nextID int64
	mu     sync.Mutex
	calls  map[int64]chan rpcMessage  // our requests awaiting an answer
	perms  map[string]json.RawMessage // the server's open approval requests, by id
	turnID string
	items  map[string]int // content index per item of the turn, for deltas
	last   string         // the turn's last final answer
	usage  *struct {
		Input  int `json:"inputTokens"`
		Cached int `json:"cachedInputTokens"`
		Output int `json:"outputTokens"`
	}
	window int // the model's context window, when the token usage says

	thread string
	path   string
	model  string

	queue  chan agent.Event
	events chan agent.Event

	stderrMu   sync.Mutex
	stderrTail []string

	exited chan struct{}
}

var _ agent.Process = (*Process)(nil)

// Start spawns the app-server and opens the thread: a new one in Cwd, or
// Resume. It returns once the thread is open, so SessionID is known.
func Start(ctx context.Context, o Options) (*Process, error) {
	if o.Cwd == "" {
		return nil, errors.New("codex: Cwd is required")
	}
	if o.Bin == "" {
		bin, err := FindBinary()
		if err != nil {
			return nil, err
		}
		o.Bin = bin
	}
	if o.CloseGrace == 0 {
		o.CloseGrace = 10 * time.Second
	}
	cmd := exec.CommandContext(ctx, o.Bin, "app-server")
	cmd.Dir = o.Cwd
	if len(o.Env) > 0 {
		cmd.Env = append(os.Environ(), o.Env...)
	}
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &Process{
		cmd: cmd, stdin: stdin, grace: o.CloseGrace, opts: o,
		calls:  map[int64]chan rpcMessage{},
		perms:  map[string]json.RawMessage{},
		items:  map[string]int{},
		queue:  make(chan agent.Event, 64),
		events: make(chan agent.Event),
		exited: make(chan struct{}),
	}
	stderrDone := make(chan struct{})
	go func() {
		p.readStderr(stderr)
		close(stderrDone)
	}()
	go p.pump()
	go func() {
		p.readStdout(stdout)
		<-stderrDone
		err := cmd.Wait()
		if err != nil {
			if tail := p.stderrText(); tail != "" {
				err = fmt.Errorf("%w: %s", err, tail)
			}
		}
		p.failCalls()
		close(p.exited)
		p.queue <- agent.Event{Kind: agent.KindExit, Err: err}
		close(p.queue)
	}()
	if err := p.open(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

// open does the handshake and starts or resumes the thread.
func (p *Process) open(ctx context.Context) error {
	if _, err := p.call(ctx, "initialize", map[string]any{
		"clientInfo": map[string]any{"name": "dakort", "title": "Dakort", "version": "0"}, "capabilities": nil}); err != nil {
		return err
	}
	if err := p.write(map[string]any{"jsonrpc": "2.0", "method": "initialized", "params": map[string]any{}}); err != nil {
		return err
	}
	approval, sandbox, reviewer := Policy(p.opts.PermissionMode)
	params := map[string]any{"cwd": p.opts.Cwd, "approvalPolicy": approval, "sandbox": sandbox, "approvalsReviewer": reviewer}
	if p.opts.Model != "" {
		params["model"] = p.opts.Model
	}
	method := "thread/start"
	if p.opts.Resume != "" {
		method = "thread/resume"
		params["threadId"] = p.opts.Resume
		params["excludeTurns"] = true
	}
	res, err := p.call(ctx, method, params)
	if err != nil {
		return err
	}
	var r struct {
		Thread struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"thread"`
		Model string `json:"model"`
	}
	if err := json.Unmarshal(res, &r); err != nil || r.Thread.ID == "" {
		return fmt.Errorf("codex: %s gave no thread: %s", method, res)
	}
	p.thread, p.path, p.model = r.Thread.ID, r.Thread.Path, r.Model
	return nil
}

// SessionID is the thread id (Codex picks it for a new thread).
func (p *Process) SessionID() string { return p.thread }

// Path is the rollout file, as the app-server reported it.
func (p *Process) Path() string { return p.path }

func (p *Process) Events() <-chan agent.Event { return p.events }

func (p *Process) PID() int { return p.cmd.Process.Pid }

func (p *Process) pump() {
	var buf []agent.Event
	in := p.queue
	for in != nil || len(buf) > 0 {
		var out chan agent.Event
		var next agent.Event
		if len(buf) > 0 {
			out, next = p.events, buf[0]
		}
		select {
		case ev, ok := <-in:
			if !ok {
				in = nil
				continue
			}
			buf = append(buf, ev)
		case out <- next:
			buf[0] = agent.Event{}
			buf = buf[1:]
		}
	}
	close(p.events)
}

func (p *Process) readStderr(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		p.stderrMu.Lock()
		p.stderrTail = append(p.stderrTail, sc.Text())
		if len(p.stderrTail) > 20 {
			p.stderrTail = p.stderrTail[1:]
		}
		p.stderrMu.Unlock()
	}
	io.Copy(io.Discard, r)
}

func (p *Process) stderrText() string {
	p.stderrMu.Lock()
	defer p.stderrMu.Unlock()
	return strings.TrimSpace(strings.Join(p.stderrTail, "\n"))
}

func (p *Process) readStdout(r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		line = bytes.TrimSpace(line)
		if len(line) > 0 {
			p.handleLine(line)
		}
		if err != nil {
			return
		}
	}
}

func (p *Process) handleLine(line []byte) {
	var m rpcMessage
	if err := json.Unmarshal(line, &m); err != nil {
		p.queue <- agent.Event{Kind: agent.KindOther, Raw: line}
		return
	}
	switch {
	case m.Method == "" && len(m.ID) > 0:
		// An answer to one of ours.
		id, _ := strconv.ParseInt(string(m.ID), 10, 64)
		p.mu.Lock()
		ch := p.calls[id]
		delete(p.calls, id)
		p.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	case len(m.ID) > 0:
		p.handleRequest(m, line)
	default:
		p.handleNotification(m, line)
	}
}

// handleRequest answers the server's requests: approvals become
// permission events, anything else is refused so the turn goes on.
func (p *Process) handleRequest(m rpcMessage, line []byte) {
	id := string(m.ID)
	var req struct {
		Reason    string `json:"reason"`
		Command   string `json:"command"`
		Cwd       string `json:"cwd"`
		GrantRoot string `json:"grantRoot"`
		ItemID    string `json:"itemId"`
	}
	json.Unmarshal(m.Params, &req)
	perm := &agent.PermissionRequest{ID: id, ToolUseID: req.ItemID, Reason: req.Reason}
	switch m.Method {
	case "item/commandExecution/requestApproval":
		perm.Tool = "Bash"
		perm.Input, _ = json.Marshal(map[string]string{"command": req.Command})
	case "item/fileChange/requestApproval":
		perm.Tool = "Edit"
		perm.Input, _ = json.Marshal(map[string]string{"file_path": req.GrantRoot})
	case "item/permissions/requestApproval":
		perm.Tool = "Permissions"
		perm.Input = m.Params
	default:
		// Questions to the person (item/tool/requestUserInput), MCP
		// elicitations, token refreshes: nothing here can answer them.
		p.write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{
			"code": -32601, "message": "not supported by this client: " + m.Method}})
		return
	}
	p.mu.Lock()
	p.perms[id] = m.ID
	p.mu.Unlock()
	p.queue <- agent.Event{Kind: agent.KindPermission, Raw: line, Permission: perm}
}

func (p *Process) handleNotification(m rpcMessage, line []byte) {
	var n struct {
		ItemID    string          `json:"itemId"`
		Delta     string          `json:"delta"`
		RequestID json.RawMessage `json:"requestId"`
		Item      *struct {
			Type  string `json:"type"`
			ID    string `json:"id"`
			Text  string `json:"text"`
			Phase string `json:"phase"`
		} `json:"item"`
		Turn *struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"turn"`
		TokenUsage *struct {
			Last json.RawMessage `json:"last"`
			// The model's context window: ThreadTokenUsage's
			// modelContextWindow (number or null) in the app server's own
			// schema (codex 0.166.0, app-server generate-ts, 2026-10-31);
			// the rollout's task_started says 258400 for gpt-5.6-sol.
			Window int `json:"modelContextWindow"`
		} `json:"tokenUsage"`
	}
	json.Unmarshal(m.Params, &n)
	ev := agent.Event{Kind: agent.KindOther, SessionID: p.thread, Raw: line}
	switch m.Method {
	case "turn/started":
		p.mu.Lock()
		p.items, p.last, p.usage = map[string]int{}, "", nil
		if n.Turn != nil {
			p.turnID = n.Turn.ID
		}
		p.mu.Unlock()
		ev.Kind, ev.Model, ev.Cwd = agent.KindInit, p.model, p.opts.Cwd
	case "item/agentMessage/delta", "item/reasoning/summaryTextDelta":
		ev.Kind, ev.Text = agent.KindTextDelta, n.Delta
		if m.Method != "item/agentMessage/delta" {
			ev.Kind = agent.KindThinkingDelta
		}
		ev.Index = p.index(n.ItemID)
	case "item/completed":
		if n.Item == nil {
			break
		}
		ev.UUID = n.Item.ID
		switch n.Item.Type {
		case "userMessage":
			ev.Kind, ev.Replay = agent.KindUser, true
		case "agentMessage":
			ev.Kind = agent.KindAssistant
			p.mu.Lock()
			if n.Item.Phase != "commentary" {
				p.last = n.Item.Text
			}
			p.mu.Unlock()
		default:
			ev.Kind = agent.KindAssistant // a command, an edit, a search: a row of the reply
		}
	case "serverRequest/resolved":
		// Withdrawn (the turn was interrupted) or answered by someone else.
		id := string(n.RequestID)
		p.mu.Lock()
		_, open := p.perms[id]
		delete(p.perms, id)
		p.mu.Unlock()
		if open {
			ev.Kind, ev.RequestID = agent.KindPermissionCancel, id
		}
	case "thread/tokenUsage/updated":
		if n.TokenUsage != nil {
			p.mu.Lock()
			p.usage = nil
			json.Unmarshal(n.TokenUsage.Last, &p.usage)
			if n.TokenUsage.Window > 0 {
				p.window = n.TokenUsage.Window
			}
			p.mu.Unlock()
		}
	case "turn/completed":
		if n.Turn == nil {
			break
		}
		p.mu.Lock()
		res := &agent.Result{OK: n.Turn.Status != "failed", Interrupted: n.Turn.Status == "interrupted", Text: p.last, NumTurns: 1}
		if n.Turn.Error != nil && n.Turn.Error.Message != "" {
			res.Errors = []string{n.Turn.Error.Message}
			// Not signed in: "unexpected status 401 Unauthorized: Missing
			// bearer or basic authentication in header", after some 20 s
			// of retries (measured 2026-10-29, codex 0.163.0).
			res.SignedOut = strings.Contains(n.Turn.Error.Message, "401 Unauthorized")
		}
		if u := p.usage; u != nil {
			// In Claude's shape, which the context meter reads.
			res.Usage, _ = json.Marshal(map[string]int{"input_tokens": u.Input - u.Cached, "cache_read_input_tokens": u.Cached, "output_tokens": u.Output})
		}
		if p.window > 0 {
			res.ContextWindows = map[string]int{p.model: p.window}
		}
		p.mu.Unlock()
		ev.Kind, ev.Result = agent.KindResult, res
	}
	p.queue <- ev
}

// index numbers a turn's items in order of appearance, as the content
// block index deltas carry.
func (p *Process) index(item string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	i, ok := p.items[item]
	if !ok {
		i = len(p.items)
		p.items[item] = i
	}
	return i
}

func (p *Process) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if p.closed {
		return errors.New("codex: stdin closed")
	}
	_, err = p.stdin.Write(append(b, '\n'))
	return err
}

// call sends a request and waits for its result.
func (p *Process) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := atomic.AddInt64(&p.nextID, 1)
	ch := make(chan rpcMessage, 1)
	p.mu.Lock()
	p.calls[id] = ch
	p.mu.Unlock()
	drop := func() {
		p.mu.Lock()
		delete(p.calls, id)
		p.mu.Unlock()
	}
	if err := p.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		drop()
		return nil, err
	}
	select {
	case m := <-ch:
		if m.Error != nil {
			return nil, fmt.Errorf("codex: %s: %s", method, m.Error.Message)
		}
		return m.Result, nil
	case <-p.exited:
		drop()
		return nil, errors.New("codex process exited")
	case <-ctx.Done():
		drop()
		return nil, ctx.Err()
	}
}

func (p *Process) failCalls() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, ch := range p.calls {
		ch <- rpcMessage{Error: &struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}{Message: "codex process exited"}}
		delete(p.calls, id)
	}
}

// Send starts a turn with the message. Images go in as data URLs.
func (p *Process) Send(m agent.Message) error {
	input := []map[string]any{}
	for _, img := range m.Images {
		input = append(input, map[string]any{"type": "image",
			"url": "data:" + img.MediaType + ";base64," + base64.StdEncoding.EncodeToString(img.Data)})
	}
	if m.Text != "" || len(input) == 0 {
		input = append(input, map[string]any{"type": "text", "text": m.Text, "text_elements": []any{}})
	}
	params := map[string]any{"threadId": p.thread, "input": input, "summary": "auto"}
	if p.opts.Effort != "" {
		params["effort"] = p.opts.Effort
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := p.call(ctx, "turn/start", params)
	if err != nil {
		return err
	}
	var r struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	json.Unmarshal(res, &r)
	p.mu.Lock()
	if r.Turn.ID != "" {
		p.turnID = r.Turn.ID
	}
	p.mu.Unlock()
	return nil
}

func (p *Process) decide(id, decision string) error {
	p.mu.Lock()
	raw, ok := p.perms[id]
	delete(p.perms, id)
	p.mu.Unlock()
	if !ok {
		return fmt.Errorf("codex: no pending approval request %q", id)
	}
	return p.write(map[string]any{"jsonrpc": "2.0", "id": raw, "result": map[string]any{"decision": decision}})
}

// Allow accepts an approval request; input is ignored (Codex takes no
// changed input).
func (p *Process) Allow(id string, input json.RawMessage) error {
	return p.decide(id, "accept")
}

// Deny declines it. The message has nowhere to go: Codex's approvals
// carry no reason back to the model.
func (p *Process) Deny(id, message string) error {
	return p.decide(id, "decline")
}

func (p *Process) Interrupt(ctx context.Context) error {
	p.mu.Lock()
	turn := p.turnID
	p.mu.Unlock()
	if turn == "" {
		return errors.New("codex: no turn to interrupt")
	}
	_, err := p.call(ctx, "turn/interrupt", map[string]any{"threadId": p.thread, "turnId": turn})
	return err
}

// Rename sets the thread's name (Codex keeps it in its own index).
func (p *Process) Rename(ctx context.Context, name string) error {
	_, err := p.call(ctx, "thread/name/set", map[string]any{"threadId": p.thread, "name": name})
	return err
}

// Close shuts stdin, on which the app-server exits at once (measured:
// 0.1 s), and kills it if it has not after the grace period.
func (p *Process) Close() error {
	p.writeMu.Lock()
	if !p.closed {
		p.closed = true
		p.stdin.Close()
	}
	p.writeMu.Unlock()
	select {
	case <-p.exited:
		return nil
	case <-time.After(p.grace):
		p.cmd.Process.Kill()
		<-p.exited
		return errors.New("codex: killed after close grace period")
	}
}

// Model is one entry of the app-server's model list.
type Model struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Description   string   `json:"description"`
	Efforts       []string `json:"efforts"`
	DefaultEffort string   `json:"defaultEffort"`
}

// Models asks a fresh app-server which models the account offers. No
// thread is opened, so nothing is written to disk.
func Models(ctx context.Context, bin string) ([]Model, error) {
	if bin == "" {
		var err error
		if bin, err = FindBinary(); err != nil {
			return nil, err
		}
	}
	cmd := exec.CommandContext(ctx, bin, "app-server")
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	defer func() {
		stdin.Close()
		cmd.Wait()
	}()
	send := func(id int, method string, params any) error {
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		_, err := stdin.Write(append(b, '\n'))
		return err
	}
	if err := send(1, "initialize", map[string]any{"clientInfo": map[string]any{"name": "dakort", "title": "Dakort", "version": "0"}, "capabilities": nil}); err != nil {
		return nil, err
	}
	br := bufio.NewReaderSize(stdout, 1<<20)
	var list []Model
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			return nil, fmt.Errorf("codex: app-server ended before answering: %w", err)
		}
		var m rpcMessage
		if json.Unmarshal(line, &m) != nil || m.Method != "" {
			continue
		}
		if m.Error != nil {
			return nil, errors.New("codex: " + m.Error.Message)
		}
		switch string(m.ID) {
		case "1":
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "initialized", "params": map[string]any{}})
			stdin.Write(append(b, '\n'))
			if err := send(2, "model/list", map[string]any{}); err != nil {
				return nil, err
			}
		case "2":
			var r struct {
				Data []struct {
					ID          string `json:"id"`
					DisplayName string `json:"displayName"`
					Description string `json:"description"`
					Hidden      bool   `json:"hidden"`
					Efforts     []struct {
						ReasoningEffort string `json:"reasoningEffort"`
					} `json:"supportedReasoningEfforts"`
					DefaultEffort string `json:"defaultReasoningEffort"`
				} `json:"data"`
			}
			if err := json.Unmarshal(m.Result, &r); err != nil {
				return nil, err
			}
			for _, d := range r.Data {
				if d.Hidden {
					continue
				}
				md := Model{ID: d.ID, Label: d.DisplayName, Description: d.Description, DefaultEffort: d.DefaultEffort}
				for _, e := range d.Efforts {
					md.Efforts = append(md.Efforts, e.ReasoningEffort)
				}
				list = append(list, md)
			}
			return list, nil
		}
	}
}
