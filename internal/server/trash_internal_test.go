package server

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// Only old entries named like trash entries are removed; anything else in
// the folder is left alone, however old.
func TestEmptyTrash(t *testing.T) {
	trash := t.TempDir()
	const id = "11111111-2222-4333-8444-555555555555"
	old := strconv.FormatInt(time.Now().Add(-31*24*time.Hour).UnixMilli(), 10)
	recent := strconv.FormatInt(time.Now().Add(-time.Hour).UnixMilli(), 10)
	for _, name := range []string{"made-trash-" + old + "-" + id, "made-trash-" + recent + "-" + id, "not-ours-" + old, "made-trash-" + old + "-x"} {
		os.MkdirAll(filepath.Join(trash, name), 0o755)
		os.WriteFile(filepath.Join(trash, name, "f"), []byte("x"), 0o644)
	}
	emptyTrash(trash)
	for name, want := range map[string]bool{
		"made-trash-" + old + "-" + id:    false,
		"made-trash-" + recent + "-" + id: true,
		"not-ours-" + old:                 true,
		"made-trash-" + old + "-x":        true,
	} {
		_, err := os.Stat(filepath.Join(trash, name))
		if (err == nil) != want {
			t.Errorf("%s: present=%v, want %v", name, err == nil, want)
		}
	}
}

// "default" clears a remembered choice; empty keeps it.
func TestSettingsMemory(t *testing.T) {
	r := newRunner(newHub(), nil, "", "", 1, func() {})
	yes, no := true, false
	st := r.settings("s", sendRequest{Model: "opus", Effort: "high", Ultracode: &yes})
	if st.model != "opus" || st.effort != "high" || !st.ultracode {
		t.Fatalf("first: %+v", st)
	}
	st = r.settings("s", sendRequest{})
	if st.model != "opus" || st.effort != "high" || !st.ultracode {
		t.Errorf("empty request changed the settings: %+v", st)
	}
	st = r.settings("s", sendRequest{Model: "default", Effort: "default", Ultracode: &no})
	if st.model != "" || st.effort != "" || st.ultracode {
		t.Errorf("default did not clear: %+v", st)
	}

	// Saved to a file, the choices survive a restart.
	file := filepath.Join(t.TempDir(), "sessions.json")
	r1 := newRunner(newHub(), nil, "", "", 1, func() {})
	r1.loadSettings(file)
	r1.settings("a", sendRequest{Model: "haiku", Effort: "high", PermissionMode: "plan", Ultracode: &yes, Chrome: &yes})
	r2 := newRunner(newHub(), nil, "", "", 1, func() {})
	r2.loadSettings(file)
	if got := r2.settingsOf("a"); got != (sessionSettings{model: "haiku", effort: "high", permissionMode: "plan", ultracode: true, chrome: true}) {
		t.Errorf("after a restart: %+v", got)
	}
}
