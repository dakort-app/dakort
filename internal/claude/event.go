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

	// system/task_started, system/task_progress (the CLI's source,
	// claude 2.1.327; task_progress not yet seen in a measured stream).
	// Its usage is read from Usage below, the result's field of that name.
	TaskID       string `json:"task_id"`
	ToolUseID    string `json:"tool_use_id"`
	SubagentType string `json:"subagent_type"`
	TaskType     string `json:"task_type"`
	LastToolName string `json:"last_tool_name"`
	Summary      string `json:"summary"`

	// assistant: the message, read for its tool calls only. Raw, as the
	// field is not an object on every line type.
	Message json.RawMessage `json:"message"`

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
		case "task_started", "task_progress":
			if l.TaskID == "" {
				break
			}
			info := &agent.Task{ID: l.TaskID, Type: l.TaskType, ToolUseID: l.ToolUseID, Subagent: l.SubagentType}
			if l.Subtype == "task_progress" {
				var u struct {
					ToolUses   int   `json:"tool_uses"`
					DurationMS int64 `json:"duration_ms"`
				}
				json.Unmarshal(l.Usage, &u)
				info.Steps, info.Running = u.ToolUses, u.DurationMS
				info.Last = firstLine(l.Summary)
				if info.Last == "" {
					info.Last = l.LastToolName
				}
			}
			ev.Kind, ev.TaskInfo = agent.KindTaskInfo, info
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
		ev.ToolCalls = toolCalls(l.Message)
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

// toolCalls reads an assistant message's Agent and Bash calls, whose
// inputs say what a background task started by one is.
func toolCalls(msg json.RawMessage) []agent.ToolCall {
	if len(msg) == 0 || msg[0] != '{' {
		return nil
	}
	var m struct {
		Content []struct {
			Type  string `json:"type"`
			ID    string `json:"id"`
			Name  string `json:"name"`
			Input struct {
				Model        string `json:"model"`
				SubagentType string `json:"subagent_type"`
				Command      string `json:"command"`
			} `json:"input"`
		} `json:"content"`
	}
	if json.Unmarshal(msg, &m) != nil {
		return nil
	}
	var out []agent.ToolCall
	for _, b := range m.Content {
		if b.Type != "tool_use" || (b.Name != "Agent" && b.Name != "Task" && b.Name != "Bash") {
			continue
		}
		out = append(out, agent.ToolCall{ID: b.ID, Name: b.Name, Model: b.Input.Model, Subagent: b.Input.SubagentType, Command: b.Input.Command})
	}
	return out
}

// firstLine is s's first non-empty line, trimmed.
func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}
