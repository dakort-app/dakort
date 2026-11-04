package transcript

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Codex keeps a session ("thread") as a rollout file under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. Each line is
// {timestamp, ordinal, type, payload}. What the lines hold (measured
// 2026-10-28, codex 0.163, and a 64 MB rollout from 0.154; BRIEF "Codex
// rollouts"):
//
//   - session_meta: the first line; the thread id, cwd, version.
//   - response_item: what goes to the model. message (role user, developer
//     or assistant; the user ones carry the CLI's own context blocks as
//     well as the prompt), reasoning (encrypted, a summary at most),
//     function_call / custom_tool_call and their _output. Commands and
//     edits go through one tool, "exec", whose input is JavaScript: the
//     real actions are the items below.
//   - event_msg: what the UI sees. item_completed carries an item:
//     UserMessage (the prompt as typed), AgentMessage (same text as the
//     assistant message), CommandExecution (command, output, exit code),
//     FileChange, WebSearch / Extension (web.search), ImageView,
//     Reasoning, ContextCompaction. Also task_started / task_complete,
//     token_count, turn_aborted, thread_settings_applied.
//   - turn_context: the model, effort, approval policy and sandbox of a
//     turn. token_usage_record: the usage of one API call. compacted: a
//     compaction, with the replacement history. world_state: skipped.
//
// The rows a Codex session shows are made of the UserMessage items, the
// assistant messages, reasoning summaries, the action items (each as a
// tool call and its result, two rows from one line) and the tools that
// are not exec. Everything else is bookkeeping.

type codexLine struct {
	Timestamp time.Time       `json:"timestamp"`
	Ordinal   int64           `json:"ordinal"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexPayload struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"` // message: [{type, text}]
	Summary   json.RawMessage `json:"summary"` // reasoning: strings or {text}s
	Name      string          `json:"name"`
	CallID    string          `json:"call_id"`
	Arguments string          `json:"arguments"` // function_call: a JSON string
	Input     string          `json:"input"`     // custom_tool_call
	Output    json.RawMessage `json:"output"`    // *_output: a string or parts
	Item      json.RawMessage `json:"item"`      // item_completed
	TurnID    string          `json:"turn_id"`
	Usage     *struct {
		Input int `json:"input_tokens"` // the whole prompt, cached part included
	} `json:"usage"` // token_usage_record
	Window int `json:"model_context_window"` // task_started
}

type codexItem struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"` // UserMessage
	// CommandExecution
	Command   json.RawMessage `json:"command"` // [program, args...] or a string
	ParsedCmd []struct {
		Type string `json:"type"`
		Name string `json:"name"`
	} `json:"parsed_cmd"`
	AggregatedOutput string `json:"aggregated_output"`
	ExitCode         *int   `json:"exit_code"`
	Status           string `json:"status"`
	// FileChange
	Changes json.RawMessage `json:"changes"` // {path: {type, content}} or [{path, kind}]
	Stdout  string          `json:"stdout"`
	Stderr  string          `json:"stderr"`
	// WebSearch, Extension
	Query   string `json:"query"`
	Results []struct {
		Domain string `json:"domain"`
		Title  string `json:"title"`
	} `json:"results"`
	Path string `json:"path"` // ImageView
}

var codexSkip = []byte(`"world_state"`)

func (p parser) codexRows(line []byte, start, end int64) []Row {
	if bytes.HasPrefix(line, codexSkip) || len(line) == 0 || line[0] != '{' {
		return nil
	}
	var l codexLine
	if err := json.Unmarshal(line, &l); err != nil {
		return nil
	}
	var pl codexPayload
	if json.Unmarshal(l.Payload, &pl) != nil {
		return nil
	}
	// Lines without an id of their own get one from their place in the file.
	synthetic := func(prefix string) string {
		if l.Ordinal > 0 {
			return fmt.Sprintf("%s%d", prefix, l.Ordinal)
		}
		return fmt.Sprintf("%s@%d", prefix, start)
	}
	row := func(uuid string, role Role) Row {
		return Row{UUID: uuid, Role: role, Time: l.Timestamp, Offset: start, End: end}
	}
	// call and answer are the two rows of an action item.
	call := func(id, name string, input map[string]string) Row {
		r := row(id, Assistant)
		in, _ := json.Marshal(input)
		r.Blocks = []Block{{Type: "tool_use", ID: id, Name: name, Input: in}}
		return r
	}
	answer := func(id, text string, isError bool) Row {
		r := row(id+"/out", User)
		r.Blocks = []Block{{Type: "tool_result", ID: id, IsError: isError, Content: []Block{{Type: "text", Text: text}}}}
		return r
	}

	switch l.Type {
	case "response_item":
		switch pl.Type {
		case "message":
			if pl.Role != "assistant" {
				return nil // the person's prompt is the UserMessage item; developer rows are the CLI's
			}
			r := row(pl.ID, Assistant)
			r.MessageID = pl.ID
			for _, t := range codexTexts(pl.Content) {
				r.Blocks = append(r.Blocks, Block{Type: "text", Text: t})
			}
			return []Row{r}
		case "reasoning":
			text := strings.Join(codexTexts(pl.Summary), "\n\n")
			if text == "" {
				return nil // encrypted, nothing to show
			}
			r := row(pl.ID, Assistant)
			r.Blocks = []Block{{Type: "thinking", Text: text}}
			return []Row{r}
		case "function_call", "custom_tool_call":
			if pl.Name == "exec" {
				return nil // the actions it took are items of their own
			}
			r := row(pl.ID, Assistant)
			var in json.RawMessage
			if json.Valid([]byte(pl.Arguments)) && strings.HasPrefix(strings.TrimSpace(pl.Arguments), "{") {
				in = json.RawMessage(pl.Arguments)
			} else {
				in, _ = json.Marshal(map[string]string{"input": pl.Input + pl.Arguments})
			}
			r.Blocks = []Block{{Type: "tool_use", ID: pl.CallID, Name: pl.Name, Input: in}}
			return []Row{r}
		case "function_call_output", "custom_tool_call_output":
			r := row(pl.ID, User)
			var text string
			if json.Unmarshal(pl.Output, &text) != nil {
				text = strings.Join(codexTexts(pl.Output), "")
			}
			r.Blocks = []Block{{Type: "tool_result", ID: pl.CallID, Content: []Block{{Type: "text", Text: text}}}}
			return []Row{r}
		}
	case "event_msg":
		switch pl.Type {
		case "task_started":
			if pl.Window <= 0 {
				return nil
			}
			// The model's context window, for the composer's bar; no words
			// of its own, so a sidechain row like the usage rows.
			r := row(synthetic("window"), Assistant)
			r.Window, r.Sidechain = pl.Window, true
			return []Row{r}
		case "item_completed":
			var it codexItem
			if json.Unmarshal(pl.Item, &it) != nil {
				return nil
			}
			switch it.Type {
			case "UserMessage":
				r := row(it.ID, User)
				for _, c := range it.Content {
					switch c.Type {
					case "text":
						r.Blocks = append(r.Blocks, Block{Type: "text", Text: codexPrompt(c.Text)})
					case "image", "local_image", "localImage":
						r.Blocks = append(r.Blocks, Block{Type: "image"})
					}
				}
				return []Row{r}
			case "CommandExecution":
				cmd := codexCommand(it.Command)
				desc := ""
				if len(it.ParsedCmd) > 0 && it.ParsedCmd[0].Name != "" {
					desc = it.ParsedCmd[0].Type + " " + it.ParsedCmd[0].Name
				}
				failed := it.ExitCode != nil && *it.ExitCode != 0 || it.Status == "failed"
				return []Row{call(it.ID, "Bash", map[string]string{"command": cmd, "description": desc}),
					answer(it.ID, it.AggregatedOutput, failed)}
			case "FileChange":
				paths, kinds := codexChanges(it.Changes)
				name := "Edit"
				if len(kinds) > 0 && kinds[0] == "add" {
					name = "Write"
				}
				out := it.Stdout
				if it.Status == "failed" && it.Stderr != "" {
					out = it.Stderr
				}
				in := map[string]string{"file_path": strings.Join(paths, ", ")}
				return []Row{call(it.ID, name, in), answer(it.ID, out, it.Status == "failed")}
			case "WebSearch", "Extension":
				rows := []Row{call(it.ID, "WebSearch", map[string]string{"query": it.Query})}
				var lines []string
				for _, res := range it.Results {
					if res.Title != "" {
						lines = append(lines, strings.TrimSpace(res.Domain+" "+res.Title))
					}
				}
				if len(lines) > 0 {
					rows = append(rows, answer(it.ID, strings.Join(lines, "\n"), false))
				}
				return rows
			case "ImageView":
				return []Row{call(it.ID, "ImageView", map[string]string{"path": strings.TrimPrefix(it.Path, "file:///")})}
			}
		case "turn_aborted":
			r := row(synthetic("abort"), User)
			r.Blocks = []Block{{Type: "text", Text: "[Request interrupted by user]"}}
			return []Row{r}
		}
	case "token_usage_record":
		if pl.Usage == nil || pl.Usage.Input == 0 {
			return nil
		}
		// The context meter reads the last assistant row's size. This row
		// has no words of its own; the sidechain flag keeps it out of the
		// transcript's groups.
		r := row(synthetic("usage"), Assistant)
		r.Context, r.Sidechain = pl.Usage.Input, true
		return []Row{r}
	case "compacted":
		r := row(synthetic("compact"), System)
		r.Subtype, r.Level, r.Content = "compact_boundary", "info", "Conversation compacted"
		return []Row{r}
	}
	return nil
}

// codexTexts flattens message content, a reasoning summary or a tool
// output: a list of strings or of {type, text} parts.
func codexTexts(raw json.RawMessage) []string {
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var out []string
		for _, p := range parts {
			if p.Text != "" {
				out = append(out, p.Text)
			}
		}
		return out
	}
	var strs []string
	if json.Unmarshal(raw, &strs) == nil {
		return strs
	}
	return nil
}

// codexCommand shows a command the way it was meant: a script handed to
// PowerShell or a shell as the script, anything else as its words.
func codexCommand(raw json.RawMessage) string {
	var words []string
	if json.Unmarshal(raw, &words) != nil {
		var s string
		json.Unmarshal(raw, &s)
		return s
	}
	if len(words) == 3 {
		switch strings.ToLower(words[1]) {
		case "-command", "-c", "-lc":
			return words[2]
		}
	}
	return strings.Join(words, " ")
}

// codexChanges lists the files of a FileChange: a map by path in the
// rollout, a list of {path, kind} in the app-server's items.
func codexChanges(raw json.RawMessage) (paths, kinds []string) {
	var byPath map[string]struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &byPath) == nil {
		for p, c := range byPath {
			paths, kinds = append(paths, p), append(kinds, c.Type)
		}
		return
	}
	var list []struct {
		Path string `json:"path"`
		Kind string `json:"kind"`
	}
	json.Unmarshal(raw, &list)
	for _, c := range list {
		paths, kinds = append(paths, c.Path), append(kinds, c.Kind)
	}
	return
}

// codexPrompt is the prompt as typed. The VS Code extension wraps it in a
// note about the open editor tabs, which is noise on a phone.
func codexPrompt(text string) string {
	if strings.HasPrefix(text, "# Context from my IDE setup") {
		if _, after, ok := strings.Cut(text, "## My request:"); ok {
			return strings.TrimSpace(after)
		}
	}
	return text
}

// CodexHead reads the start of a rollout: the session_meta line, then on
// to the first prompt, within maxBytes.
func CodexHead(path string, maxBytes int64) (Info, error) {
	f, err := open(path)
	if err != nil {
		return Info{}, err
	}
	defer f.Close()
	var info Info
	info.Entrypoint = "codex"
	p := parser{codex: true, skipBinary: true}
	br := bufio.NewReaderSize(f, 1<<20)
	for info.Scanned < maxBytes {
		line, err := br.ReadBytes('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			return info, err
		}
		info.Scanned += int64(len(line))
		if info.SessionID == "" {
			var l codexLine
			var meta struct {
				ID        string    `json:"id"`
				Cwd       string    `json:"cwd"`
				Timestamp time.Time `json:"timestamp"`
				Version   string    `json:"cli_version"`
				// "vscode", "exec", ... or {"subagent": ...} for a thread
				// Codex starts by itself (a guardian review of an action).
				Source json.RawMessage `json:"source"`
			}
			if json.Unmarshal(line, &l) == nil && l.Type == "session_meta" && json.Unmarshal(l.Payload, &meta) == nil {
				info.SessionID, info.Cwd, info.Version, info.First = meta.ID, meta.Cwd, meta.Version, meta.Timestamp
				var src struct {
					Subagent json.RawMessage `json:"subagent"`
				}
				info.Subagent = json.Unmarshal(meta.Source, &src) == nil && len(src.Subagent) > 0
				if info.First.IsZero() {
					info.First = l.Timestamp
				}
			}
			continue
		}
		if !bytes.Contains(line, []byte(`"UserMessage"`)) {
			continue
		}
		for _, row := range p.codexRows(line, 0, 0) {
			if row.Role == User {
				info.FirstPrompt = row.PromptText()
			}
		}
		if info.FirstPrompt != "" {
			break
		}
	}
	return info, nil
}

// CodexLastActivity is LastActivity for a rollout.
func CodexLastActivity(path string) (time.Time, error) {
	return lastActivity(path, parser{codex: true, skipBinary: true})
}

var turnContextKey = []byte(`"turn_context"`)

// CodexLastUsed is what a rollout's last turn ran with, from its
// turn_context line: the model and effort, and the approval policy and
// sandbox given as the permission mode they stand for (CodexMode).
func CodexLastUsed(path string, maxBytes int64) (Used, error) {
	var u Used
	f, err := open(path)
	if err != nil {
		return u, err
	}
	defer f.Close()
	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return u, err
	}
	for chunk := int64(64 << 10); ; chunk *= 2 {
		start := max(size-min(chunk, maxBytes), 0)
		buf := make([]byte, size-start)
		if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
			return u, err
		}
		lines := bytes.Split(buf, []byte{'\n'})
		first := 0
		if start > 0 {
			first = 1
		}
		for i := len(lines) - 2; i >= first; i-- {
			if !bytes.Contains(lines[i], turnContextKey) {
				continue
			}
			var l codexLine
			var tc struct {
				Model    string `json:"model"`
				Effort   string `json:"effort"`
				Approval string `json:"approval_policy"`
				Reviewer string `json:"approvals_reviewer"`
				Sandbox  struct {
					Type string `json:"type"`
				} `json:"sandbox_policy"`
			}
			if json.Unmarshal(lines[i], &l) != nil || l.Type != "turn_context" || json.Unmarshal(l.Payload, &tc) != nil {
				continue
			}
			u.Model, u.Mode = tc.Model, CodexMode(tc.Approval, tc.Sandbox.Type, tc.Reviewer)
			return u, nil
		}
		if start == 0 || chunk >= maxBytes {
			return u, nil
		}
	}
}

// CodexMode names a Codex approval policy and sandbox by the permission
// mode of the picker (Claude's names, one list for both providers):
// bypassPermissions is no approvals and no sandbox, dontAsk no approvals
// in the workspace sandbox, plan a read-only sandbox, auto an automatic
// reviewer, manual the rest. Empty when the pair is none of these.
func CodexMode(approval, sandbox, reviewer string) string {
	switch {
	case approval == "never" && sandbox == "danger-full-access":
		return "bypassPermissions"
	case approval == "never":
		return "dontAsk"
	case sandbox == "read-only":
		return "plan"
	case reviewer == "auto_review":
		return "auto"
	case approval != "":
		return "manual"
	}
	return ""
}

// CodexSessionsRoot is ~/.codex/sessions; CodexIndexFile the CLI's
// session_index.jsonl of {id, thread_name, updated_at} lines beside it.
func CodexSessionsRoot() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "sessions")
}

func CodexIndexFile() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "session_index.jsonl")
}

// IsRollout says whether a file name is a Codex rollout's, and gives the
// thread id in it: rollout-2026-10-28T17-18-30-<uuid>.jsonl.
func IsRollout(name string) (id string, ok bool) {
	if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
		return "", false
	}
	id = strings.TrimSuffix(name, ".jsonl")
	if len(id) < 36 {
		return "", false
	}
	return id[len(id)-36:], true
}
