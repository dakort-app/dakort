package server

import (
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/claude"
)

// A missing CLI is named with its install command, and one installed
// while the app runs is found on a later ask, not before lookAgain.
func TestCLIInstalledLater(t *testing.T) {
	installed := false
	c := newCLIPaths("", "")
	c.findClaude = func() (string, error) {
		if installed {
			return "/somewhere/claude", nil
		}
		return "", nil
	}
	c.findCodex = func() (string, error) { return "", nil }
	st := c.status()
	if st[0].Found || !strings.Contains(st[0].Install, "claude.ai/install") || st[0].SignIn != "claude" {
		t.Errorf("claude missing: %+v", st[0])
	}
	if st[1].Found || st[1].Install != "npm install -g @openai/codex" {
		t.Errorf("codex missing: %+v", st[1])
	}
	installed = true
	if c.Claude() != "" {
		t.Error("looked again at once")
	}
	c.claudeLook = time.Now().Add(-lookAgain)
	if c.Claude() != "/somewhere/claude" {
		t.Error("not found after lookAgain")
	}
	if st := c.status(); !st[0].Found || st[0].Install != "" {
		t.Errorf("claude installed: %+v", st[0])
	}
}

// On this machine Claude is installed, and the status says so.
func TestRealCLIStatus(t *testing.T) {
	bin, err := claude.FindBinary()
	if err != nil {
		t.Skip(err)
	}
	if st := newCLIPaths(bin, "").status(); !st[0].Found {
		t.Errorf("%+v", st[0])
	}
}
