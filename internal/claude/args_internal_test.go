package claude

import (
	"slices"
	"testing"
)

// --chrome only when asked: the tools cost context on every turn.
func TestChromeFlag(t *testing.T) {
	if slices.Contains(Options{}.args(), "--chrome") {
		t.Error("--chrome without Chrome")
	}
	if !slices.Contains(Options{Chrome: true}.args(), "--chrome") {
		t.Error("no --chrome with Chrome")
	}
}
