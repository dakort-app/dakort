//go:build !windows

package main

import (
	"log"
	"os"
	"syscall"
)

// swapStaged, at a service start, puts a build staged by dakort setup
// (bin/dakort.new) in the running binary's place and starts that instead:
// launchd and systemd restart the server when it exits with code 75 after
// POST /api/restart, and the new build is what comes up. On Windows the
// task's wrapper does this between runs.
func swapStaged() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	staged := exe + ".new"
	if _, err := os.Stat(staged); err != nil {
		return
	}
	if err := os.Rename(staged, exe); err != nil {
		log.Printf("could not swap %s in: %v", staged, err)
		return
	}
	log.Printf("swapped %s in; starting it", staged)
	if err := syscall.Exec(exe, os.Args, os.Environ()); err != nil {
		log.Printf("starting the swapped build: %v; carrying on with this one", err)
	}
}
