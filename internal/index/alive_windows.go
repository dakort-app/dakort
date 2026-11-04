package index

import (
	"strconv"
	"syscall"
)

const (
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259
)

// alive reports whether pid is a running process created at procStart (a
// FILETIME in decimal, as the CLI writes it), so a reused pid does not
// count. An empty procStart checks only that the pid runs.
func alive(pid int, procStart string) bool {
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		// Denied means it runs, under a logon we may not look into: the
		// server runs as a task at boot (S4U), and a Claude started at the
		// desktop refused it, so every session open there read as free
		// and a folder rename got as far as Windows' "Access is denied"
		// (2026-11-03). Only a missing pid is gone.
		return err == syscall.ERROR_ACCESS_DENIED
	}
	defer syscall.CloseHandle(h)
	// A process that exited stays openable while anyone holds a handle.
	var code uint32
	if syscall.GetExitCodeProcess(h, &code) != nil || code != stillActive {
		return false
	}
	if procStart == "" {
		return true
	}
	want, err := strconv.ParseUint(procStart, 10, 64)
	if err != nil {
		return true
	}
	var created, exited, kernel, user syscall.Filetime
	if syscall.GetProcessTimes(h, &created, &exited, &kernel, &user) != nil {
		return false
	}
	return uint64(created.HighDateTime)<<32|uint64(created.LowDateTime) == want
}
