package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestWrapperGoesBack runs the task's wrapper with the build gone (as when
// the antivirus quarantines a new dakort.exe the moment it is swapped in):
// it puts the build before it back and runs that, instead of leaving the
// service down. Without a build before it, it ends rather than loop.
func TestWrapperGoesBack(t *testing.T) {
	home := t.TempDir()
	svc := winService{setupOpts{port: 1, home: home, name: "madetest-wrapper"}}
	if err := os.MkdirAll(svc.bin(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(svc.logs(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(svc.wrapper(), []byte(svc.definition()), 0o600); err != nil {
		t.Fatal(err)
	}
	run := func() string {
		done := make(chan error, 1)
		cmd := exec.Command("cmd.exe", "/d", "/c", svc.wrapper())
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			cmd.Process.Kill()
			t.Fatal("the wrapper did not end")
		}
		log, _ := os.ReadFile(svc.log())
		return string(log)
	}

	// No build and none before it: the wrapper ends.
	if log := run(); strings.Contains(log, "going back") {
		t.Errorf("went back with nothing to go back to:\n%s", log)
	}

	// A stand-in for the build before (any program that ends at once).
	prev, err := os.ReadFile(filepath.Join(os.Getenv("SystemRoot"), "System32", "hostname.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(svc.exe()+".old", prev, 0o755); err != nil {
		t.Fatal(err)
	}
	log := run()
	if !strings.Contains(log, "going back to the one before it") {
		t.Errorf("the wrapper did not go back:\n%s", log)
	}
	if _, err := os.Stat(svc.exe()); err != nil {
		t.Errorf("the build before is not in place: %v", err)
	}
	if _, err := os.Stat(svc.exe() + ".old"); err == nil {
		t.Error("the build before is still beside it")
	}
	if n := strings.Count(log, "starting"); n != 3 {
		t.Errorf("%d starts, want 3 (one alone, then gone and back):\n%s", n, log)
	}
}
