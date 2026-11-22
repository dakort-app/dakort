// Package term runs a shell in a pseudo-terminal, for the page's terminal
// panel: what the shell prints is read from the PTY, what is typed is
// written to it, and a resize tells the shell the new size. Windows uses
// ConPTY (pty_windows.go), as VS Code's node-pty does; macOS and Linux use
// a Unix PTY (pty_unix.go).
package term

import (
	"io"
	"os"
)

// PTY is a shell running in a pseudo-terminal.
type PTY interface {
	io.Reader // what the shell prints, with its escape codes
	io.Writer // what is typed
	Resize(cols, rows int) error
	// Close ends the shell and what it started, and releases the PTY;
	// a Read in progress returns an error. Safe to call more than once.
	Close() error
	// Wait returns once the shell has exited.
	Wait() error
}

// Start runs the shell in dir at the given size, with the environment of
// this process plus env.
func Start(shell []string, dir string, env []string, cols, rows int) (PTY, error) {
	return start(shell, dir, env, clampSize(cols), clampSize(rows))
}

// Shell is the shell a terminal starts: on Windows PowerShell 7 (pwsh)
// when installed, else Windows PowerShell; elsewhere $SHELL as a login
// shell, else bash or sh.
func Shell() []string { return shell() }

func clampSize(n int) int { return max(2, min(n, 1000)) }

func firstFile(paths ...string) string {
	for _, p := range paths {
		if p == "" {
			continue
		}
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}
