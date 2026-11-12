package main

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The service's definition names the binary, the port and the data
// folder, and on Windows is a CRLF batch file with the restart loop.
func TestServiceDefinition(t *testing.T) {
	// A space in the install folder, as in most user folders.
	o := setupOpts{port: 3005, home: filepath.Join(t.TempDir(), "madetest home"), data: `C:\x y\data`, name: "DakortTest"}
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
	if runtime.GOOS == "linux" {
		// systemd takes a path setting as written: quotes around a folder
		// with a space made the unit fail to load.
		if !strings.Contains(def, "\nWorkingDirectory="+o.home+"\n") {
			t.Errorf("the unit's WorkingDirectory is not the bare path:\n%s", def)
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

// exposedHosts: a named address is itself; every interface becomes this
// machine's own IPv4 addresses, each with the port.
func TestExposedHosts(t *testing.T) {
	if got := exposedHosts("192.168.1.20:3002"); len(got) != 1 || got[0] != "192.168.1.20:3002" {
		t.Errorf("named: %v", got)
	}
	for _, all := range []string{":3002", "0.0.0.0:3002"} {
		for _, h := range exposedHosts(all) {
			host, port, err := net.SplitHostPort(h)
			if err != nil || port != "3002" || net.ParseIP(host) == nil || net.ParseIP(host).IsLoopback() || net.ParseIP(host).IsUnspecified() {
				t.Errorf("%s gave %q", all, h)
			}
		}
	}
}
