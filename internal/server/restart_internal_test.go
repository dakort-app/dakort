package server

import "testing"

// A restart waits for a process held for background tasks however long it
// stays, and goes the moment nothing is left.
func TestStopIfIdleWaitsForTasks(t *testing.T) {
	r := &runner{turns: map[string]*turn{"s": {held: true}}}
	for range 3 {
		if r.stopIfIdle() {
			t.Fatal("stopped with a process held for background tasks")
		}
	}
	delete(r.turns, "s")
	if !r.stopIfIdle() {
		t.Fatal("not stopped with nothing running")
	}
	if !r.stopped || r.stopIfIdle() {
		t.Error("a second stop, or not marked stopped")
	}
}
