package transcript

import (
	"os"
	"path/filepath"
	"testing"
)

// A transcript the reader has open can still be deleted (on Windows, a
// plain os.Open blocks this until close).
func TestOpenAllowsDelete(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := os.Remove(path); err != nil {
		t.Errorf("delete while open: %v", err)
	}
}
