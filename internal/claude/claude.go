// Package claude drives the Claude Code CLI over its stream-json protocol:
// one JSON object per line on stdin and stdout, with control_request and
// control_response lines for permissions and interrupts.
package claude

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/agent"
)

type Options struct {
	Bin string // path to claude; FindBinary() when empty
	Cwd string

	Resume    string // session id to resume
	Fork      bool   // with Resume: continue under a new session id
	SessionID string // id for a new session; the CLI picks one when empty

	Model          string // alias (opus, sonnet, haiku) or full name
	Effort         string // low, medium, high, xhigh, max; the CLI's default when empty
	Settings       string // extra settings as a JSON object (--settings), e.g. {"ultracode":true}
	PermissionMode string // acceptEdits, auto, bypassPermissions, manual, dontAsk, plan
	SettingSources string // e.g. "project,user,local"; CLI default when empty

	// ReplayUserMessages makes the CLI echo each sent prompt back as a user
	// event carrying its transcript uuid.
	ReplayUserMessages bool

	// Chrome gives the turn the Claude in Chrome tools (--chrome). In -p
	// mode the CLI leaves them off even when the user's settings enable
	// them by default (see NOTES).
	Chrome bool

	ExtraArgs []string
	Env       []string // added to the inherited environment

	// CloseGrace is how long Close waits for a clean exit before killing.
	CloseGrace time.Duration
}

// FindBinary looks for claude on PATH, then in the native installer's
// location (~/.local/bin).
func FindBinary() (string, error) {
	if p, err := exec.LookPath("claude"); err == nil {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	name := "claude"
	if runtime.GOOS == "windows" {
		name = "claude.exe"
	}
	p := filepath.Join(home, ".local", "bin", name)
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("claude not found on PATH or at %s", p)
	}
	return p, nil
}

func (o Options) args() []string {
	a := []string{
		"-p",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-prompt-tool", "stdio",
	}
	if o.Resume != "" {
		a = append(a, "--resume", o.Resume)
		if o.Fork {
			a = append(a, "--fork-session")
		}
	}
	if o.SessionID != "" {
		a = append(a, "--session-id", o.SessionID)
	}
	if o.Model != "" {
		a = append(a, "--model", o.Model)
	}
	if o.Effort != "" {
		a = append(a, "--effort", o.Effort)
	}
	if o.Settings != "" {
		a = append(a, "--settings", o.Settings)
	}
	if o.PermissionMode != "" {
		a = append(a, "--permission-mode", o.PermissionMode)
	}
	if o.SettingSources != "" {
		a = append(a, "--setting-sources", o.SettingSources)
	}
	if o.ReplayUserMessages {
		a = append(a, "--replay-user-messages")
	}
	if o.Chrome {
		a = append(a, "--chrome")
	}
	return append(a, o.ExtraArgs...)
}

// inheritedPlumbing names variables a parent Claude Code session sets for
// its own children. Passing them on would make our CLI think it is a
// subprocess of that session.
var inheritedPlumbing = map[string]bool{
	"CLAUDECODE":                           true,
	"CLAUDE_PID":                           true,
	"CLAUDE_AGENT_SDK_VERSION":             true,
	"CLAUDE_CODE_ENTRYPOINT":               true,
	"CLAUDE_CODE_SESSION_ID":               true,
	"CLAUDE_CODE_CHILD_SESSION":            true,
	"CLAUDE_CODE_SESSION_ATTENDED":         true,
	"CLAUDE_CODE_MESSAGING_SOCKET":         true,
	"CLAUDE_CODE_MESSAGING_TOKEN":          true,
	"CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS": true,
}

func environ(extra []string) []string {
	var env []string
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if !inheritedPlumbing[strings.ToUpper(name)] {
			env = append(env, kv)
		}
	}
	return append(env, extra...)
}

type pendingPermission struct {
	input     json.RawMessage
	toolUseID string
}

type Process struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	grace time.Duration

	writeMu sync.Mutex
	closed  bool

	mu       sync.Mutex
	perms    map[string]pendingPermission
	controls map[string]chan controlResponse

	queue  chan agent.Event // reader to pump, unbounded via pump's slice
	events chan agent.Event

	stderrMu   sync.Mutex
	stderrTail []string

	exited chan struct{}
}

var _ agent.Process = (*Process)(nil)

// Start spawns the CLI. It returns once the process is running; the CLI
// emits nothing until the first Send.
func Start(ctx context.Context, o Options) (*Process, error) {
	if o.Cwd == "" {
		// An empty Dir would inherit the server's cwd and file the session
		// under the server's own project folder.
		return nil, errors.New("claude: Cwd is required")
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
	cmd := exec.CommandContext(ctx, o.Bin, o.args()...)
	cmd.Dir = o.Cwd
	cmd.Env = environ(o.Env)
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
		cmd:      cmd,
		stdin:    stdin,
		grace:    o.CloseGrace,
		perms:    map[string]pendingPermission{},
		controls: map[string]chan controlResponse{},
		queue:    make(chan agent.Event, 64),
		events:   make(chan agent.Event),
		exited:   make(chan struct{}),
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
		p.failControls(errors.New("claude process exited"))
		close(p.exited)
		p.queue <- agent.Event{Kind: agent.KindExit, Err: err}
		close(p.queue)
	}()
	return p, nil
}

func (p *Process) Events() <-chan agent.Event { return p.events }

// PID is the CLI's process id, as it appears in the live-session registry.
func (p *Process) PID() int { return p.cmd.Process.Pid }

// pump moves events from the reader to the consumer through a slice, so a
// slow consumer never blocks the reader. A blocked reader would stop
// control responses arriving, and Interrupt would hang.
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
	// Scan stops on an over-long line; keep draining so the CLI never
	// blocks on a full stderr pipe.
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
	var head struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Request   json.RawMessage
		Response  controlResponse
	}
	if err := json.Unmarshal(line, &head); err != nil {
		p.queue <- agent.Event{Kind: agent.KindOther, Raw: line}
		return
	}
	switch head.Type {
	case "control_response":
		p.mu.Lock()
		ch := p.controls[head.Response.RequestID]
		delete(p.controls, head.Response.RequestID)
		p.mu.Unlock()
		if ch != nil {
			ch <- head.Response
		}
		return
	case "control_request":
		p.handleControlRequest(head.RequestID, head.Request, line)
		return
	case "control_cancel_request":
		p.mu.Lock()
		delete(p.perms, head.RequestID)
		p.mu.Unlock()
		p.queue <- agent.Event{Kind: agent.KindPermissionCancel, RequestID: head.RequestID, Raw: line}
		return
	case "keep_alive":
		return
	}
	for _, ev := range parseEvent(line) {
		p.queue <- ev
	}
}

func (p *Process) handleControlRequest(id string, raw json.RawMessage, line []byte) {
	var req struct {
		Subtype        string          `json:"subtype"`
		ToolName       string          `json:"tool_name"`
		Input          json.RawMessage `json:"input"`
		ToolUseID      string          `json:"tool_use_id"`
		Description    string          `json:"description"`
		DecisionReason string          `json:"decision_reason"`
		BlockedPath    string          `json:"blocked_path"`
		Suggestions    json.RawMessage `json:"permission_suggestions"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		p.write(map[string]any{"type": "control_response", "response": map[string]any{
			"subtype": "error", "request_id": id, "error": "unreadable control request: " + err.Error()}})
		return
	}
	if req.Subtype != "can_use_tool" {
		// We register no hooks or SDK MCP servers, so nothing else should
		// arrive. Answer anyway so the CLI never waits on us.
		p.write(map[string]any{"type": "control_response", "response": map[string]any{
			"subtype": "error", "request_id": id, "error": "unsupported control request: " + req.Subtype}})
		return
	}
	p.mu.Lock()
	p.perms[id] = pendingPermission{input: req.Input, toolUseID: req.ToolUseID}
	p.mu.Unlock()
	p.queue <- agent.Event{Kind: agent.KindPermission, Raw: line, Permission: &agent.PermissionRequest{
		ID:          id,
		Tool:        req.ToolName,
		ToolUseID:   req.ToolUseID,
		Input:       req.Input,
		Description: req.Description,
		Reason:      req.DecisionReason,
		BlockedPath: req.BlockedPath,
		Suggestions: req.Suggestions,
	}}
}

func (p *Process) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if p.closed {
		return errors.New("claude: stdin closed")
	}
	_, err = p.stdin.Write(append(b, '\n'))
	return err
}

// Send writes one user message.
func (p *Process) Send(m agent.Message) error {
	var content any = m.Text
	if len(m.Images) > 0 {
		blocks := []map[string]any{}
		for _, img := range m.Images {
			blocks = append(blocks, map[string]any{"type": "image", "source": map[string]any{
				"type": "base64", "media_type": img.MediaType,
				"data": base64.StdEncoding.EncodeToString(img.Data)}})
		}
		if m.Text != "" {
			blocks = append(blocks, map[string]any{"type": "text", "text": m.Text})
		}
		content = blocks
	}
	return p.write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})
}

func (p *Process) takePermission(id string) (pendingPermission, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pp, ok := p.perms[id]
	if !ok {
		return pp, fmt.Errorf("claude: no pending permission request %q", id)
	}
	delete(p.perms, id)
	return pp, nil
}

func (p *Process) Allow(id string, input json.RawMessage) error {
	pp, err := p.takePermission(id)
	if err != nil {
		return err
	}
	if input == nil {
		input = pp.input
	}
	return p.write(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": id, "response": map[string]any{
			"behavior": "allow", "updatedInput": input, "toolUseID": pp.toolUseID}}})
}

func (p *Process) Deny(id, message string) error {
	pp, err := p.takePermission(id)
	if err != nil {
		return err
	}
	return p.write(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": id, "response": map[string]any{
			"behavior": "deny", "message": message, "toolUseID": pp.toolUseID}}})
}

type controlResponse struct {
	Subtype   string          `json:"subtype"`
	RequestID string          `json:"request_id"`
	Response  json.RawMessage `json:"response"`
	Error     string          `json:"error"`
}

// control sends a control request and waits for its response.
func (p *Process) control(ctx context.Context, req map[string]any) (json.RawMessage, error) {
	var rb [8]byte
	rand.Read(rb[:])
	id := hex.EncodeToString(rb[:])
	ch := make(chan controlResponse, 1)
	p.mu.Lock()
	p.controls[id] = ch
	p.mu.Unlock()
	if err := p.write(map[string]any{"type": "control_request", "request_id": id, "request": req}); err != nil {
		p.mu.Lock()
		delete(p.controls, id)
		p.mu.Unlock()
		return nil, err
	}
	select {
	case r := <-ch:
		if r.Subtype != "success" {
			return nil, fmt.Errorf("claude: %s failed: %s", req["subtype"], r.Error)
		}
		return r.Response, nil
	case <-p.exited:
		// Registered after failControls ran; nothing will answer.
		p.mu.Lock()
		delete(p.controls, id)
		p.mu.Unlock()
		return nil, errors.New("claude process exited")
	case <-ctx.Done():
		p.mu.Lock()
		delete(p.controls, id)
		p.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (p *Process) failControls(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, ch := range p.controls {
		ch <- controlResponse{Subtype: "error", RequestID: id, Error: err.Error()}
		delete(p.controls, id)
	}
}

func (p *Process) Interrupt(ctx context.Context) error {
	_, err := p.control(ctx, map[string]any{"subtype": "interrupt"})
	return err
}

// StopTask stops one background task (a Bash run in the background, a
// Monitor). The CLI then reports the tasks left; unlike a task that ends
// by itself, it does not wake the model (measured 2026-10-26).
func (p *Process) StopTask(ctx context.Context, id string) error {
	_, err := p.control(ctx, map[string]any{"subtype": "stop_task", "task_id": id})
	return err
}

// SetModel and SetPermissionMode change a live process's settings for the
// turns after; a fresh process takes them as flags instead.
func (p *Process) SetModel(ctx context.Context, model string) error {
	_, err := p.control(ctx, map[string]any{"subtype": "set_model", "model": model})
	return err
}

func (p *Process) SetPermissionMode(ctx context.Context, mode string) error {
	_, err := p.control(ctx, map[string]any{"subtype": "set_permission_mode", "mode": mode})
	return err
}

// Initialize asks the CLI what it offers: slash commands, models, account
// (BRIEF). It needs no user line, so it makes no API call and writes no
// transcript.
func (p *Process) Initialize(ctx context.Context) (json.RawMessage, error) {
	return p.control(ctx, map[string]any{"subtype": "initialize"})
}

// Close shuts stdin, which makes the CLI finish and exit, and kills it if
// it has not exited after the grace period. It returns once the process is
// gone; the KindExit event carries the exit status.
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
		return errors.New("claude: killed after close grace period")
	}
}
