//go:build !windows

package codex

import "os/exec"

func hideWindow(*exec.Cmd) {}
