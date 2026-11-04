package transcript_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dakort-app/dakort/internal/transcript"
)

// A rollout with one line of every shape the survey of real files found
// (codex 0.154 to 0.163), trimmed to what the reader looks at.
var codexLines = []string{
	`{"timestamp":"2026-10-29T00:18:39.000Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a18505-e800-7fc1-a19e-1688d38eee32","id":"01a18505-e800-7fc1-a19e-1688d38eee32","timestamp":"2026-10-29T00:18:38.500Z","cwd":"C:\\Users\\Sam Lee\\Desktop\\temp\\ben","originator":"codex_vscode","cli_version":"0.163.0","source":"vscode"}}`,
	`{"timestamp":"2026-10-29T00:18:39.100Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"t1","model_context_window":258400}}`,
	`{"timestamp":"2026-10-29T00:18:39.200Z","ordinal":2,"type":"response_item","payload":{"type":"message","id":"msg_dev","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>stuff</skills_instructions>"}]}}`,
	`{"timestamp":"2026-10-29T00:18:39.300Z","ordinal":3,"type":"world_state","payload":{"full":true,"state":{}}}`,
	`{"timestamp":"2026-10-29T00:18:39.400Z","ordinal":4,"type":"turn_context","payload":{"turn_id":"t1","cwd":"C:\\Users\\Sam Lee\\Desktop\\temp\\ben","approval_policy":"on-request","approvals_reviewer":"user","sandbox_policy":{"type":"workspace-write","network_access":false},"model":"gpt-5.6-sol","effort":"low"}}`,
	`{"timestamp":"2026-10-29T00:18:39.500Z","ordinal":5,"type":"response_item","payload":{"type":"message","id":"msg_u1","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"},{"type":"input_text","text":"# Context from my IDE setup:\n\n## Open tabs:\n- a.md\n\n## My request:\nmake hello.txt say hi"}]}}`,
	`{"timestamp":"2026-10-29T00:18:39.600Z","ordinal":6,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a18505-e800-7fc1-a19e-1688d38eee32","turn_id":"t1","item":{"type":"UserMessage","id":"item-1","content":[{"type":"text","text":"# Context from my IDE setup:\n\n## Open tabs:\n- a.md\n\n## My request:\nmake hello.txt say hi","text_elements":[]}]}}}`,
	`{"timestamp":"2026-10-29T00:18:41.000Z","ordinal":7,"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"AgentMessage","id":"item-2","content":[{"type":"Text","text":"On it."}],"phase":"commentary"}}}`,
	`{"timestamp":"2026-10-29T00:18:41.100Z","ordinal":8,"type":"response_item","payload":{"type":"message","status":"completed","id":"msg_a1","role":"assistant","content":[{"type":"output_text","text":"On it."}],"phase":"commentary"}}`,
	`{"timestamp":"2026-10-29T00:18:41.200Z","ordinal":9,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_1","status":"completed","call_id":"call_1","name":"exec","input":"const r = await tools.write_file(...)"}}`,
	`{"timestamp":"2026-10-29T00:18:41.300Z","ordinal":10,"type":"token_usage_record","payload":{"thread_id":"01a18505-e800-7fc1-a19e-1688d38eee32","turn_id":"t1","response_id":"resp_1","usage":{"input_tokens":17434,"cached_input_tokens":12416,"output_tokens":57,"total_tokens":17491}}}`,
	`{"timestamp":"2026-10-29T00:18:52.000Z","ordinal":11,"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"FileChange","id":"exec-fc1","changes":{"C:\\Users\\Sam Lee\\Desktop\\temp\\ben\\hello.txt":{"type":"add","content":"hi\n"}},"status":"completed","stdout":"Success. Updated the following files:\nA hello.txt\n","stderr":""}}}`,
	`{"timestamp":"2026-10-29T00:18:52.100Z","ordinal":12,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_1","call_id":"call_1","output":[{"type":"input_text","text":"Script completed\n"},{"type":"input_text","text":"{}"}]}}`,
	`{"timestamp":"2026-10-29T00:18:53.000Z","ordinal":13,"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"Reasoning","id":"rs_1","summary_text":[],"raw_content":[]}}}`,
	`{"timestamp":"2026-10-29T00:18:53.100Z","ordinal":14,"type":"response_item","payload":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"gAAAA"}}`,
	`{"timestamp":"2026-10-29T00:18:53.200Z","ordinal":15,"type":"response_item","payload":{"type":"reasoning","id":"rs_2","summary":[{"type":"summary_text","text":"Checking the file."}],"encrypted_content":"gAAAA"}}`,
	`{"timestamp":"2026-10-29T00:18:55.000Z","ordinal":16,"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"CommandExecution","id":"exec-c1","process_id":"1","command":["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe","-Command","Get-Content -LiteralPath .\\hello.txt"],"cwd":"file:///C:/Users/Sam%20Lee/Desktop/temp/ben","parsed_cmd":[{"type":"read","cmd":"Get-Content -LiteralPath .\\hello.txt","name":"hello.txt","path":"./hello.txt"}],"source":"unified_exec_startup","status":"completed","aggregated_output":"hi\r\n","exit_code":0,"duration":{"secs":0,"nanos":35900}}}}`,
	`{"timestamp":"2026-10-29T00:18:56.000Z","ordinal":17,"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"WebSearch","id":"exec-ws1","query":"nserc discovery grants","action":{"type":"search"},"results":[{"type":"text_result","domain":"www.nserc-crsng.gc.ca","title":"Discovery Grants"}]}}}`,
	`{"timestamp":"2026-10-29T00:18:57.000Z","ordinal":18,"type":"response_item","payload":{"type":"function_call","id":"fc_1","name":"wait","arguments":"{\"cell_id\":\"69\"}","call_id":"call_2"}}`,
	`{"timestamp":"2026-10-29T00:18:58.000Z","ordinal":19,"type":"response_item","payload":{"type":"function_call_output","id":"fco_1","call_id":"call_2","output":"done"}}`,
	`{"timestamp":"2026-10-29T00:18:59.000Z","ordinal":20,"type":"response_item","payload":{"type":"message","status":"completed","id":"msg_a2","role":"assistant","content":[{"type":"output_text","text":"Created hello.txt."}],"phase":"final_answer"}}`,
	`{"timestamp":"2026-10-29T00:18:59.100Z","ordinal":21,"type":"token_usage_record","payload":{"turn_id":"t1","response_id":"resp_2","usage":{"input_tokens":17600,"cached_input_tokens":17000,"output_tokens":10,"total_tokens":17610}}}`,
	`{"timestamp":"2026-10-29T00:18:59.200Z","ordinal":22,"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"Created hello.txt."}}`,
	`{"timestamp":"2026-10-29T00:19:00.000Z","ordinal":23,"type":"compacted","payload":{"message":"","replacement_history":[]}}`,
	`{"timestamp":"2026-10-29T00:19:01.000Z","ordinal":24,"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t2","reason":"interrupted"}}`,
	`{"timestamp":"2026-10-29T00:19:02.000Z","ordinal":25,"type":"turn_context","payload":{"turn_id":"t3","approval_policy":"never","approvals_reviewer":"user","sandbox_policy":{"type":"danger-full-access"},"model":"gpt-6-sol","effort":"high"}}`,
	`{"timestamp":"2026-10-29T00:19:03.000Z","ordinal":26,"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"x","thread_settings":{"model":"gpt-6-sol"}}}`,
}

func writeRollout(t *testing.T, lines []string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rollout-2026-10-28T17-18-39-01a18505-e800-7fc1-a19e-1688d38eee32.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCodexRows(t *testing.T) {
	path := writeRollout(t, codexLines)
	r := &transcript.Reader{Path: path, Format: "codex"}
	rows, err := r.All()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"window1", "item-1", "msg_a1", "usage10", "exec-fc1", "exec-fc1/out", "ctco_1", "rs_2", "exec-c1", "exec-c1/out",
		"exec-ws1", "exec-ws1/out", "fc_1", "fco_1", "msg_a2", "usage21", "compact23", "abort24"}
	if got := uuids(rows); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("rows:\n got %v\nwant %v", got, want)
	}
	by := map[string]transcript.Row{}
	for _, row := range rows {
		by[row.UUID] = row
	}
	first := by["item-1"]
	if p := first.PromptText(); p != "make hello.txt say hi" {
		t.Errorf("prompt: %q", p)
	}
	if b := by["msg_a1"].Blocks; len(b) != 1 || b[0].Text != "On it." || by["msg_a1"].Role != transcript.Assistant {
		t.Errorf("assistant message: %+v", by["msg_a1"])
	}
	if u := by["usage10"]; u.Context != 17434 || !u.Sidechain || u.Role != transcript.Assistant {
		t.Errorf("usage row: %+v", u)
	}
	if w := by["window1"]; w.Window != 258400 || !w.Sidechain || w.Context != 0 {
		t.Errorf("window row: %+v", w)
	}
	if b := by["exec-fc1"].Blocks[0]; b.Type != "tool_use" || b.Name != "Write" || !strings.Contains(string(b.Input), "hello.txt") {
		t.Errorf("file change call: %+v", b)
	}
	if b := by["exec-fc1/out"].Blocks[0]; b.Type != "tool_result" || b.ID != "exec-fc1" || !strings.HasPrefix(b.Content[0].Text, "Success") {
		t.Errorf("file change result: %+v", b)
	}
	if b := by["exec-c1"].Blocks[0]; b.Name != "Bash" || !strings.Contains(string(b.Input), `"command":"Get-Content -LiteralPath .\\hello.txt"`) || !strings.Contains(string(b.Input), `"description":"read hello.txt"`) {
		t.Errorf("command call: %s", b.Input)
	}
	if b := by["exec-c1/out"].Blocks[0]; b.Content[0].Text != "hi\r\n" || b.IsError {
		t.Errorf("command result: %+v", b)
	}
	if b := by["rs_2"].Blocks[0]; b.Type != "thinking" || b.Text != "Checking the file." {
		t.Errorf("reasoning: %+v", b)
	}
	if b := by["exec-ws1/out"].Blocks[0]; b.Content[0].Text != "www.nserc-crsng.gc.ca Discovery Grants" {
		t.Errorf("web search result: %+v", b)
	}
	if b := by["fc_1"].Blocks[0]; b.Name != "wait" || string(b.Input) != `{"cell_id":"69"}` || b.ID != "call_2" {
		t.Errorf("function call: %+v", b)
	}
	if b := by["fco_1"].Blocks[0]; b.ID != "call_2" || b.Content[0].Text != "done" {
		t.Errorf("function output: %+v", b)
	}
	if c := by["compact23"]; c.Role != transcript.System || c.Subtype != "compact_boundary" {
		t.Errorf("compaction: %+v", c)
	}
	if !strings.HasPrefix(by["abort24"].Blocks[0].Text, "[Request interrupted") {
		t.Errorf("abort: %+v", by["abort24"])
	}
	// The two rows of one line share its offsets, so paging by either works.
	if by["exec-c1"].Offset != by["exec-c1/out"].Offset || by["exec-c1"].End != by["exec-c1/out"].End {
		t.Error("the call and its result should share the line's offsets")
	}
	tail, atStart, err := r.Tail(-1, 3)
	if err != nil || atStart || strings.Join(uuids(tail), " ") != "usage21 compact23 abort24" {
		t.Errorf("tail: %v %v %v", uuids(tail), atStart, err)
	}
	more, _, err := r.Tail(tail[0].Offset, 2)
	if err != nil || strings.Join(uuids(more), " ") != "fco_1 msg_a2" {
		t.Errorf("tail before: %v %v", uuids(more), err)
	}
}

func TestCodexHeadAndTail(t *testing.T) {
	path := writeRollout(t, codexLines)
	info, err := transcript.CodexHead(path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if info.SessionID != "01a18505-e800-7fc1-a19e-1688d38eee32" || info.Cwd != `C:\Users\Sam Lee\Desktop\temp\ben` ||
		info.Version != "0.163.0" || info.FirstPrompt != "make hello.txt say hi" || info.First.Format("15:04:05.000") != "00:18:38.500" {
		t.Errorf("head: %+v", info)
	}
	last, err := transcript.CodexLastActivity(path)
	if err != nil || last.Format("15:04:05") != "00:19:01" {
		t.Errorf("last activity: %v %v", last, err)
	}
	used, err := transcript.CodexLastUsed(path, 4<<20)
	if err != nil || used.Model != "gpt-6-sol" || used.Mode != "bypassPermissions" {
		t.Errorf("last used: %+v %v", used, err)
	}
	if id, ok := transcript.IsRollout(filepath.Base(path)); !ok || id != info.SessionID {
		t.Errorf("IsRollout: %q %v", id, ok)
	}
	if _, ok := transcript.IsRollout("notes.jsonl"); ok {
		t.Error("notes.jsonl is not a rollout")
	}
	for _, c := range []struct{ approval, sandbox, reviewer, want string }{
		{"on-request", "workspace-write", "user", "manual"},
		{"on-request", "workspace-write", "auto_review", "auto"},
		{"on-request", "read-only", "user", "plan"},
		{"never", "workspace-write", "user", "dontAsk"},
		{"never", "danger-full-access", "user", "bypassPermissions"},
		{"", "", "", ""},
	} {
		if got := transcript.CodexMode(c.approval, c.sandbox, c.reviewer); got != c.want {
			t.Errorf("CodexMode(%s, %s, %s) = %q, want %q", c.approval, c.sandbox, c.reviewer, got, c.want)
		}
	}
}
