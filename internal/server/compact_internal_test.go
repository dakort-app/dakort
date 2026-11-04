package server

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The cache life comes from the latest reply that wrote to the cache; one
// that only read it says nothing, and a compaction after the last reply
// means there is nothing to do.
func TestLastReplyCacheLife(t *testing.T) {
	reply := func(uuid, life string, wrote int) string {
		h, m := 0, 0
		if life == "1h" {
			h = wrote
		} else {
			m = wrote
		}
		return `{"type":"assistant","uuid":"` + uuid + `","timestamp":"2026-10-23T10:00:00Z","message":{"model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":2,"cache_read_input_tokens":250000,"cache_creation_input_tokens":` + strconv.Itoa(wrote) + `,"cache_creation":{"ephemeral_5m_input_tokens":` + strconv.Itoa(m) + `,"ephemeral_1h_input_tokens":` + strconv.Itoa(h) + `}}}}`
	}
	write := func(lines ...string) string {
		p := filepath.Join(t.TempDir(), "s.jsonl")
		os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
		return p
	}
	cases := []struct {
		name  string
		lines []string
		life  string
		ok    bool
	}{
		{"one hour", []string{reply("a", "1h", 500)}, "1h", true},
		{"five minutes", []string{reply("a", "5m", 500)}, "5m", true},
		{"last only read; the one before wrote 5m", []string{reply("a", "5m", 500), reply("b", "1h", 0)}, "5m", true},
		{"nothing says", []string{reply("a", "1h", 0)}, "", true},
		{"compacted after", []string{reply("a", "1h", 500), `{"type":"system","subtype":"compact_boundary","uuid":"s","timestamp":"2026-10-23T10:01:00Z","content":"Conversation compacted"}`}, "", false},
	}
	for _, c := range cases {
		if _, life, ok := lastReply(write(c.lines...)); ok != c.ok || life != c.life {
			t.Errorf("%s: life %q ok %v, want %q %v", c.name, life, ok, c.life, c.ok)
		}
	}
}
