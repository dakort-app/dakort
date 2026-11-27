package claude

import (
	"testing"

	"github.com/dakort-app/dakort/internal/agent"
)

// A background task's details: task_started and task_progress (their
// shapes as the CLI's source writes them, claude 2.1.327) and the Agent or
// Bash call in an assistant message.
func TestTaskInfoLines(t *testing.T) {
	ev := parseEvent([]byte(`{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"toolu_1","description":"Read the docs","subagent_type":"Explore","task_type":"local_agent"}`))[0]
	if ev.Kind != agent.KindTaskInfo || *ev.TaskInfo != (agent.Task{ID: "a1", Type: "local_agent", ToolUseID: "toolu_1", Subagent: "Explore"}) {
		t.Errorf("task_started: %s %+v", ev.Kind, ev.TaskInfo)
	}
	ev = parseEvent([]byte(`{"type":"system","subtype":"task_progress","task_id":"a1","tool_use_id":"toolu_1","usage":{"total_tokens":900,"tool_uses":4,"duration_ms":65000},"last_tool_name":"Grep","summary":"\nReading the router\nmore"}`))[0]
	if ev.Kind != agent.KindTaskInfo || ev.TaskInfo.Steps != 4 || ev.TaskInfo.Running != 65000 || ev.TaskInfo.Last != "Reading the router" {
		t.Errorf("task_progress: %s %+v", ev.Kind, ev.TaskInfo)
	}
	ev = parseEvent([]byte(`{"type":"system","subtype":"task_progress","task_id":"a1","usage":{"tool_uses":5},"last_tool_name":"Read"}`))[0]
	if ev.TaskInfo.Last != "Read" {
		t.Errorf("task_progress without a summary: %+v", ev.TaskInfo)
	}
	ev = parseEvent([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"toolu_1","name":"Agent","input":{"description":"Read the docs","model":"sonnet","subagent_type":"Explore","prompt":"..."}},{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"npm test","run_in_background":true}},{"type":"tool_use","id":"toolu_3","name":"Read","input":{"file_path":"a"}}]}}`))[0]
	want := []agent.ToolCall{{ID: "toolu_1", Name: "Agent", Model: "sonnet", Subagent: "Explore"}, {ID: "toolu_2", Name: "Bash", Command: "npm test"}}
	if ev.Kind != agent.KindAssistant || len(ev.ToolCalls) != 2 || ev.ToolCalls[0] != want[0] || ev.ToolCalls[1] != want[1] {
		t.Errorf("tool calls: %+v", ev.ToolCalls)
	}
	// A line whose message is not an object still parses.
	if ev = parseEvent([]byte(`{"type":"system","subtype":"status","message":"hello"}`))[0]; ev.Kind != agent.KindOther {
		t.Errorf("a string message: %s", ev.Kind)
	}
}
