package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The service's definition names the binary, the port and the data
// folder, and on Windows is a CRLF batch file with the restart loop.
func TestServiceDefinition(t *testing.T) {
	o := setupOpts{port: 3005, home: filepath.Join(t.TempDir(), "madetest-home"), data: `C:\x y\data`, name: "DakortTest"}
	svc := newService(o)
	def := ""
	switch s := svc.(type) {
	case interface{ definition() string }:
		def = s.definition()
	default:
		t.Fatalf("no definition on %T", svc)
	}
	for _, want := range []string{svc.exe(), "127.0.0.1:3005", "-idle-compact", "x y"} {
		if !strings.Contains(def, want) {
			t.Errorf("definition lacks %q:\n%s", want, def)
		}
	}
	if runtime.GOOS == "windows" {
		if !strings.Contains(def, "\r\n") || strings.Contains(strings.ReplaceAll(def, "\r\n", ""), "\n") {
			t.Error("the wrapper must be CRLF throughout")
		}
		if !strings.Contains(def, `"75"`) || !strings.Contains(def, svc.staged()) {
			t.Error("the wrapper lacks the restart loop")
		}
	}
	if svc.unchanged() {
		t.Error("unchanged before anything was written")
	}
	// The PATH line is every shell's own: a definition that differs in it
	// alone is unchanged (a ship from inside a turn runs under Git Bash;
	// the user's terminal is PowerShell).
	var defPath string
	switch runtime.GOOS {
	case "windows":
		defPath = filepath.Join(o.home, "start.cmd")
	default:
		t.Skip("the definition's place on this system needs the user's folders")
	}
	os.MkdirAll(filepath.Dir(defPath), 0o755)
	other := strings.Replace(def, "PATH="+os.Getenv("PATH"), `PATH=C:\elsewhere`, 1)
	if other == def {
		t.Fatal("the definition does not carry the PATH")
	}
	os.WriteFile(defPath, []byte(other), 0o600)
	if !svc.unchanged() {
		t.Error("a definition differing in PATH alone counts as changed")
	}
	os.WriteFile(defPath, []byte(strings.Replace(def, "3005", "3006", 1)), 0o600)
	if svc.unchanged() {
		t.Error("a definition differing in the port counts as unchanged")
	}
}

// qrLines gives a square of block characters that scans as the text:
// here only that it is a square with a quiet zone and nothing else.
func TestQRLines(t *testing.T) {
	lines, err := qrLines("http://laptop.example.ts.net:3002/")
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) < 10 {
		t.Fatalf("%d lines", len(lines))
	}
	for i, l := range lines {
		l = strings.TrimSuffix(strings.TrimPrefix(l, "\x1b[30;47m"), "\x1b[0m")
		if n := len([]rune(l)); n != 2*len(lines) && n != 2*len(lines)-1 {
			t.Errorf("line %d has %d modules for %d lines", i, n, len(lines))
		}
		if !strings.HasPrefix(l, "  ") || !strings.HasSuffix(l, "  ") {
			t.Errorf("line %d lacks the quiet zone: %q", i, l)
		}
	}
}
