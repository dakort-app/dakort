package claude

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the console-subsystem CLI from opening a window when the
// server itself runs without a console (as a scheduled task or service).
func hideWindow(cmd *exec.Cmd) {
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
}
