// Package agent holds the provider-neutral shapes shared by the Claude and
// Codex relays: what a caller sends, what comes back, and the process handle.
package agent

import (
	"context"
	"encoding/json"
)

// Process is one running CLI process. The default use is one process per
// turn: Send once, read Events until a KindResult, then Close. Keeping the
// process for a further Send is the optional keep-alive.
type Process interface {
	Send(Message) error
	// Events is closed after the KindExit event.
	Events() <-chan Event
	// Allow answers a permission request. A nil input keeps the tool's
	// original input.
	Allow(requestID string, input json.RawMessage) error
	// Deny answers a permission request; the message is shown to the model.
	Deny(requestID, message string) error
	// Interrupt stops the current turn. The turn still ends with a
	// KindResult whose Interrupted flag is set.
	Interrupt(ctx context.Context) error
	// Close ends the process gracefully, killing it after a grace period.
	Close() error
}

type Message struct {
	Text   string
	Images []Image
}

type Image struct {
	MediaType string // image/png, image/jpeg, image/gif, image/webp
	Data      []byte
}

type Kind string

const (
	KindInit             Kind = "init"              // SessionID, Model, Cwd
	KindTextDelta        Kind = "text_delta"        // Index, Text
	KindThinkingDelta    Kind = "thinking_delta"    // Index, Text
	KindAssistant        Kind = "assistant"         // a complete assistant content block, in Raw
	KindUser             Kind = "user"              // tool results, interrupt markers, replayed prompts
	KindPermission       Kind = "permission"        // Permission
	KindPermissionCancel Kind = "permission_cancel" // RequestID: the CLI withdrew the request
	KindTasks            Kind = "tasks"             // Tasks: the background tasks running now (may be none)
	KindResult           Kind = "result"            // Result: the turn is over
	KindExit             Kind = "exit"              // Err: the process is gone; always last
	KindOther            Kind = "other"             // status, rate limits, anything new
)

type Event struct {
	Kind      Kind
	SessionID string
	UUID      string // transcript row id, when the CLI gives one
	// ParentToolUseID is set for events from inside a subagent.
	ParentToolUseID string

	Index int    // content block index, for deltas
	Text  string // delta text

	// Replay marks the KindUser event that echoes the prompt just sent:
	// the turn is under way (Claude with --replay-user-messages, Codex's
	// userMessage item).
	Replay bool

	Model string // KindInit
	Cwd   string // KindInit

	Permission *PermissionRequest
	RequestID  string // KindPermissionCancel
	Tasks      []Task // KindTasks
	Result     *Result
	Err        error // KindExit

	// Raw is the original line from the CLI (nil for KindExit).
	Raw json.RawMessage
}

// Task is a background command or monitor the CLI runs between turns. When
// one ends (or a monitor prints), the CLI starts a turn of its own to tell
// the model, as long as its process is alive.
type Task struct {
	ID          string `json:"id"`
	Type        string `json:"type"` // local_bash, ...
	Description string `json:"description"`
}

type PermissionRequest struct {
	ID          string
	Tool        string
	ToolUseID   string
	Input       json.RawMessage
	Description string
	Reason      string
	BlockedPath string
	Suggestions json.RawMessage
}

type Result struct {
	OK             bool
	Interrupted    bool
	Text           string
	Errors         []string
	TerminalReason string
	APIErrorStatus int
	NumTurns       int
	DurationMS     int
	CostUSD        float64
	Usage          json.RawMessage
	// ContextWindows: each model the turn used and its context window in
	// tokens, as the CLI reports it (Claude's result modelUsage; Codex's
	// token usage). Empty when the CLI does not say.
	ContextWindows map[string]int
	// SignedOut: the turn failed because the CLI is not signed in (or its
	// login ran out); signing in is done in a terminal, by the person.
	SignedOut bool
}
