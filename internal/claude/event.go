package claude

import (
	"encoding/json"
	"strings"

	"github.com/dakort-app/dakort/internal/agent"
)

type line struct {
	Type            string `json:"type"`
	Subtype         string `json:"subtype"`
	SessionID       string `json:"session_id"`
	UUID            string `json:"uuid"`
	ParentToolUseID string `json:"parent_tool_use_id"`
	IsReplay        bool   `json:"isReplay"`

	// assistant: the CLI's code on a synthetic reply that stands for a
	// failed call, "authentication_failed" when the login is missing or
	// has run out (measured 2026-11-17, claude 2.1.318). Raw, as other
	// line types carry an object here and a string field would fail the
	// whole line.
	Error json.RawMessage `json:"error"`

	// system/init
	Model string `json:"model"`
	Cwd   string `json:"cwd"`

	// system/background_tasks_changed
	Tasks []struct {
		TaskID      string `json:"task_id"`
		TaskType    string `json:"task_type"`
		Description string `json:"description"`
	} `json:"tasks"`

	// stream_event
	Event *struct {
		Type  string `json:"type"`
		Index int    `json:"index"`
		Delta *struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"delta"`
	} `json:"event"`

	// result
	IsError        bool            `json:"is_error"`
	Result         string          `json:"result"`
	Errors         []string        `json:"errors"`
	TerminalReason string          `json:"terminal_reason"`
	APIErrorStatus *int            `json:"api_error_status"`
	NumTurns       int             `json:"num_turns"`
	DurationMS     int             `json:"duration_ms"`
	TotalCostUSD   float64         `json:"total_cost_usd"`
	Usage          json.RawMessage `json:"usage"`
	// Per model: {"claude-opus-5-5": {..., "contextWindow": 1000000}}
	// (measured 2026-10-31, claude 2.1.299: every current alias 1M, the
	// 4.x models 200k).
	ModelUsage map[string]struct {
		ContextWindow int `json:"contextWindow"`
	} `json:"modelUsage"`
}

// The CLI's words for a login that is missing or has run out (claude
// 2.1.318 holds six; three say "/login", the one first met on 2026-11-17
// says "claude auth login"), and for a refresh that clashed with another
// process's, which passes by itself and is no reason to sign in.
var (
	signedOutWords = []string{"/login", "auth login", "not logged in", "failed to authenticate", "login expired", "token revoked", "reached its time limit"}
	refreshClash   = "another claude code process is refreshing"
)

// signedOutText tells whether a failed turn's text says the CLI must be
// signed in again.
func signedOutText(s string) bool {
	s = strings.ToLower(s)
	if strings.Contains(s, refreshClash) {
		return false
	}
	for _, w := range signedOutWords {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

// parseEvent turns one non-control stdout line into events.
func parseEvent(raw []byte) []agent.Event {
	var l line
	if err := json.Unmarshal(raw, &l); err != nil {
		return []agent.Event{{Kind: agent.KindOther, Raw: raw}}
	}
	ev := agent.Event{
		Kind:            agent.KindOther,
		SessionID:       l.SessionID,
		UUID:            l.UUID,
		ParentToolUseID: l.ParentToolUseID,
		Raw:             raw,
	}
	switch l.Type {
	case "system":
		switch l.Subtype {
		case "init":
			ev.Kind, ev.Model, ev.Cwd = agent.KindInit, l.Model, l.Cwd
		case "background_tasks_changed":
			ev.Kind, ev.Tasks = agent.KindTasks, []agent.Task{}
			for _, t := range l.Tasks {
				ev.Tasks = append(ev.Tasks, agent.Task{ID: t.TaskID, Type: t.TaskType, Description: t.Description})
			}
		}
	case "stream_event":
		if l.Event != nil && l.Event.Type == "content_block_delta" && l.Event.Delta != nil {
			switch l.Event.Delta.Type {
			case "text_delta":
				ev.Kind, ev.Index, ev.Text = agent.KindTextDelta, l.Event.Index, l.Event.Delta.Text
			case "thinking_delta":
				ev.Kind, ev.Index, ev.Text = agent.KindThinkingDelta, l.Event.Index, l.Event.Delta.Thinking
			}
		}
	case "assistant":
		ev.Kind = agent.KindAssistant
		json.Unmarshal(l.Error, &ev.Error) // a string or nothing
	case "user":
		ev.Kind, ev.Replay = agent.KindUser, l.IsReplay
	case "result":
		ev.Kind = agent.KindResult
		r := &agent.Result{
			// subtype is "success" even for some failures (an unknown model
			// gives success with is_error true), so is_error decides.
			OK:             !l.IsError,
			Interrupted:    strings.HasPrefix(l.TerminalReason, "aborted"),
			Text:           l.Result,
			Errors:         l.Errors,
			TerminalReason: l.TerminalReason,
			NumTurns:       l.NumTurns,
			DurationMS:     l.DurationMS,
			CostUSD:        l.TotalCostUSD,
			Usage:          l.Usage,
			// The text alone; Process also sets it from the reply's
			// authentication_failed code, which survives a rewording.
			SignedOut: l.IsError && signedOutText(l.Result),
		}
		if l.APIErrorStatus != nil {
			r.APIErrorStatus = *l.APIErrorStatus
		}
		for m, u := range l.ModelUsage {
			if u.ContextWindow > 0 {
				if r.ContextWindows == nil {
					r.ContextWindows = map[string]int{}
				}
				r.ContextWindows[m] = u.ContextWindow
			}
		}
		ev.Result = r
	}
	return []agent.Event{ev}
}
