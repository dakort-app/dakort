//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"syscall"
)

// stopDetached ends a server started by startDetached (one the service
// manager does not know), by its command line: the installed binary's
// full path, followed by its arguments. Nothing else matches.
func stopDetached(exe string) {
	exec.Command("pkill", "-f", "^"+regexp.QuoteMeta(exe)+" ").Run()
}

// startDetached runs the installed server in its own session, with its
// output appended to the service's log, so it outlives this process: the
// macOS and Linux startDirect.
func startDetached(exe string, args []string, dir, logPath string) error {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = f, f
	cmd.Env = append(os.Environ(), "PATH="+servicePATH())
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
