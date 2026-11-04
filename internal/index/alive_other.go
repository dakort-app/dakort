//go:build !windows

package index

import "syscall"

// alive reports whether pid is a running process. procStart is a Windows
// FILETIME there; its form elsewhere has not been seen, so pid reuse is
// not caught off Windows.
func alive(pid int, procStart string) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
