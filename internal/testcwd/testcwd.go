// Package testcwd gives real-CLI tests a throwaway working directory and
// removes the project folder the CLI creates for it, so tests never touch
// real sessions. Only folders carrying the test marker are ever removed.
package testcwd

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/transcript"
)

// Marker is in the name of every folder this package creates.
const Marker = "madetest-"

// New makes an empty working directory and registers cleanup of both it
// and the CLI's project folder for it.
func New(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", Marker)
	if err != nil {
		t.Fatal(err)
	}
	// TEMP is an 8.3 short path on Windows (ALEXTH~1), which trips a CLI
	// safety check that real folders do not; use the long form.
	if long, err := filepath.EvalSymlinks(dir); err == nil {
		dir = long
	}
	Also(t, dir)
	return dir
}

// Also registers the same cleanup for another test folder, one a test
// made from New's (a rename): it and its project folder go at the end.
func Also(t *testing.T, dir string) {
	t.Helper()
	t.Cleanup(func() {
		// Only ever remove folders that carry the test marker. A wrong
		// computed path must never reach RemoveAll (a scratch command once
		// removed all of ~/.claude/projects this way).
		removeIfTestDir := func(p string) {
			if !strings.Contains(filepath.Base(p), Marker) {
				t.Errorf("refusing to remove %s: not a test folder", p)
				return
			}
			// On Windows a file another process has open cannot be
			// deleted (a CLI still exiting, a reader; Codex and the MCP
			// servers it starts held one 5 s past the turn), so retry a while
			// and say so rather than leak the folder silently.
			var err error
			for i := 0; i < 60; i++ {
				if err = os.RemoveAll(p); err == nil {
					return
				}
				time.Sleep(250 * time.Millisecond)
			}
			t.Errorf("test folder left behind: %v", err)
		}
		removeIfTestDir(dir)
		pd := transcript.ProjectDir(dir)
		if _, err := os.Stat(pd); err == nil {
			removeIfTestDir(pd)
			return
		}
		// The mangling guess was wrong; find the folder by its unique
		// suffix so it is still removed, and fail so the rule gets fixed.
		entries, _ := os.ReadDir(transcript.ProjectsRoot())
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), filepath.Base(dir)) {
				removeIfTestDir(filepath.Join(transcript.ProjectsRoot(), e.Name()))
				t.Errorf("project folder for %s is %s, not %s", dir, e.Name(), filepath.Base(pd))
			}
		}
	})
}

// UUID returns a random v4 uuid, for pre-assigned session ids.
func UUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
