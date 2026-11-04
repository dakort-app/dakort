package procs

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A process left behind by a command in the job is listed with its
// program, command line, folder and start time, after the command itself
// has exited; Stop ends it, and refuses a process the job never had.
func TestJob(t *testing.T) {
	job, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer job.Close()
	dir, _ := filepath.EvalSymlinks(t.TempDir())

	// start /b leaves ping running after cmd has gone, as a hung test run
	// or a backgrounded script does after its turn.
	cmd := exec.Command("cmd.exe", "/c", "start /b ping -n 30 127.0.0.1 >nul")
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if err := job.Add(cmd.Process.Pid); err != nil {
		t.Fatal("add:", err)
	}
	cmd.Wait()

	var ping Info
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline) && ping.PID == 0; time.Sleep(100 * time.Millisecond) {
		for _, in := range job.Running() {
			if strings.EqualFold(in.Name, "ping.exe") {
				ping = in
			}
		}
	}
	if ping.PID == 0 {
		t.Fatalf("ping not listed: %+v", job.Running())
	}
	defer job.Stop(ping.PID)
	t.Logf("%+v", ping)
	if !strings.Contains(strings.ToLower(ping.Command), "ping") {
		t.Errorf("command line: %q", ping.Command)
	}
	if got, _ := filepath.EvalSymlinks(ping.Dir); !strings.EqualFold(got, dir) {
		t.Errorf("folder %q, want %q", ping.Dir, dir)
	}
	if time.Since(ping.Started) > time.Minute || ping.Started.IsZero() {
		t.Errorf("started %v", ping.Started)
	}
	for _, in := range job.Running() {
		if in.Name == "conhost.exe" {
			t.Errorf("a console host listed: %+v", in)
		}
	}

	if err := job.Stop(os.Getpid()); err != ErrNotOurs {
		t.Errorf("stopping a process outside the job: %v", err)
	}
	if err := job.Stop(ping.PID); err != nil {
		t.Fatal("stop:", err)
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if len(job.Running()) == 0 {
			return
		}
	}
	t.Errorf("still listed after the stop: %+v", job.Running())
}
