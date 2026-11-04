// Package procs keeps track of what a CLI process starts, so a turn that
// leaves something running (a test run that hung, a dev server, a watcher
// on a cluster job) is seen rather than found a day later holding a folder.
//
// On Windows each session's CLI processes go in a job object, which every
// process they start inherits (measured 2026-11-03: a `sleep` that Claude's
// Bash tool left in the background stayed listed after Claude itself had
// exited; a nested job, as when the server runs under one already, works).
// The job has no kill-on-close: it is a register, never a leash. Stopping
// is a separate, deliberate act, and only for a process the job lists.
//
// Elsewhere nothing is tracked: Running lists nothing and Stop refuses.
package procs

import "time"

// Info describes one process a job lists.
type Info struct {
	PID     int       `json:"pid"`
	Name    string    `json:"name"`              // the program, "node.exe"
	Command string    `json:"command,omitempty"` // its command line, as far as it can be read
	Dir     string    `json:"dir,omitempty"`     // its working folder, which Windows will not rename while it runs
	Started time.Time `json:"started,omitzero"`
}

// maxCommand keeps a long command line (a node script with its arguments)
// to what a row can show.
const maxCommand = 300
