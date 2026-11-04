package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The folders from before the name change move over on a first start: the
// whole folder when the new one is not there, else what the new one lacks,
// leaving what it has (the installer's bin and logs) alone.
func TestMoved(t *testing.T) {
	root := t.TempDir()
	write := func(p string) {
		os.MkdirAll(filepath.Dir(p), 0o700)
		os.WriteFile(p, []byte("x"), 0o600)
	}
	old := filepath.Join(root, oldName)
	write(filepath.Join(old, "token"))
	write(filepath.Join(old, "assets", "a.png"))
	if got := moved(root, "dakort"); got != filepath.Join(root, "dakort") {
		t.Fatalf("moved to %s", got)
	}
	for _, p := range []string{"token", "assets/a.png"} {
		if _, err := os.Stat(filepath.Join(root, "dakort", p)); err != nil {
			t.Errorf("%s not moved: %v", p, err)
		}
	}
	if _, err := os.Stat(old); err == nil {
		t.Error("the old folder is still there")
	}
	if got := moved(root, "dakort"); got != filepath.Join(root, "dakort") {
		t.Errorf("a second start: %s", got)
	}

	// The new folder exists with the installer's parts in it.
	root = t.TempDir()
	old = filepath.Join(root, oldName)
	write(filepath.Join(old, "trash", "t.json"))
	write(filepath.Join(old, "bin", "made.exe"))
	write(filepath.Join(root, "dakort", "bin", "dakort.exe"))
	moved(root, "dakort")
	if _, err := os.Stat(filepath.Join(root, "dakort", "trash", "t.json")); err != nil {
		t.Error("trash not brought over")
	}
	if _, err := os.Stat(filepath.Join(root, "dakort", "bin", "dakort.exe")); err != nil {
		t.Error("the new bin was touched")
	}
	if _, err := os.Stat(filepath.Join(old, "bin", "made.exe")); err != nil {
		t.Error("the old bin, which the new one has already, should stay")
	}
}
