package server

import (
	"encoding/json"
	"testing"
)

// The initialize answer of claude 2.1.307 (2026-10-28), trimmed: the
// aliases come first, then older models by full id, which the picker
// leaves out.
const initAnswer = `{"commands":[],"models":[
{"value":"default","resolvedModel":"claude-sonnet-5-5","displayName":"Default (recommended)","description":"Sonnet 5.5 · Efficient for routine tasks","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
{"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5","description":"For complex work and everyday tasks","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
{"value":"fable","resolvedModel":"claude-fable-5-1","displayName":"Fable 5.1","description":"For your toughest challenges","supportedEffortLevels":["low","medium","high","xhigh","max"]},
{"value":"haiku","resolvedModel":"claude-haiku-5-5","displayName":"Haiku 5.5","description":"Fastest for quick answers"},
{"value":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","displayName":"Haiku 4.5","description":"Fastest for quick answers","supportsThinkingOff":true},
{"value":"claude-opus-5","resolvedModel":"claude-opus-5","displayName":"Opus 5","description":"Best for everyday, complex tasks"}
]}`

func TestParseClaudeModels(t *testing.T) {
	info := parseClaudeModels(json.RawMessage(initAnswer))
	if info == nil {
		t.Fatal("no models")
	}
	if info.DefaultModel != "claude-sonnet-5-5" {
		t.Errorf("default: %q", info.DefaultModel)
	}
	if len(info.Models) != 3 || info.Models[0].ID != "opus" || info.Models[0].Full != "claude-opus-5-5" || info.Models[0].Label != "Opus 5.5" ||
		info.Models[1].ID != "fable" || len(info.Models[1].Efforts) != 5 || info.Models[2].ID != "haiku" || info.Models[2].Efforts != nil {
		t.Errorf("models: %+v", info.Models)
	}
	if parseClaudeModels(json.RawMessage(`{"commands":[]}`)) != nil {
		t.Error("an answer without models should give nil")
	}
}
