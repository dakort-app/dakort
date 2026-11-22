//go:build !windows

package term

import (
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

// A Unix PTY through creack/pty. The shell leads a session of its own, so
// a hang-up to its process group ends it and what it started in the
// foreground.

type unixPTY struct {
	f    *os.File
	cmd  *exec.Cmd
	once sync.Once
}

func shell() []string {
	if s := os.Getenv("SHELL"); s != "" && firstFile(s) != "" {
		return []string{s, "-l"}
	}
	if p := firstFile("/bin/bash", "/usr/bin/bash", "/bin/zsh"); p != "" {
		return []string{p, "-l"}
	}
	return []string{"/bin/sh"}
}

func start(shell []string, dir string, env []string, cols, rows int) (PTY, error) {
	cmd := exec.Command(shell[0], shell[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), append([]string{"TERM=xterm-256color", "COLORTERM=truecolor"}, env...)...)
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	return &unixPTY{f: f, cmd: cmd}, nil
}

func (t *unixPTY) Read(p []byte) (int, error)  { return t.f.Read(p) }
func (t *unixPTY) Write(p []byte) (int, error) { return t.f.Write(p) }

func (t *unixPTY) Resize(cols, rows int) error {
	return pty.Setsize(t.f, &pty.Winsize{Cols: uint16(clampSize(cols)), Rows: uint16(clampSize(rows))})
}

func (t *unixPTY) Wait() error { return t.cmd.Wait() }

func (t *unixPTY) Close() error {
	t.once.Do(func() {
		if p := t.cmd.Process; p != nil {
			syscall.Kill(-p.Pid, syscall.SIGHUP)
			p.Kill()
		}
		t.f.Close()
	})
	return nil
}
