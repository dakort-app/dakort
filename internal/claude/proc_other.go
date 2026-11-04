//go:build !windows

package claude

import "os/exec"

func hideWindow(*exec.Cmd) {}
