package main

import (
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRealSetup installs a throwaway service (its own name, folder, data
// and port) with the real binary, restarts it through the hot path with a
// staged build, and removes it. Windows only so far, and only with
// administrator rights (a boot-trigger task needs them; the shell Claude
// Code runs here has them), so CI skips it.
func TestRealSetup(t *testing.T) {
	if testing.Short() || !elevated() {
		t.Skip("needs administrator rights and the real binary")
	}
	const port = "3005"
	if ln, err := net.Listen("tcp", "127.0.0.1:"+port); err != nil {
		t.Skipf("port %s is taken", port)
	} else {
		ln.Close()
	}
	home := filepath.Join(t.TempDir(), "madetest-setup")
	data := filepath.Join(home, "data")
	exe := filepath.Join(t.TempDir(), "dakort.exe")
	if out, err := exec.Command("go", "build", "-ldflags", "-X main.version=test1", "-o", exe, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	const name = "DakortTest"
	common := []string{"setup", "-name", name, "-home", home, "-data", data, "-port", port, "-no-browser"}
	run := func(args ...string) string {
		out, err := exec.Command(exe, append(common, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}
	t.Cleanup(func() {
		out, _ := exec.Command(exe, append(common, "-uninstall")...).CombinedOutput()
		t.Logf("uninstall: %s", out)
		if exec.Command("schtasks", "/Query", "/TN", name).Run() == nil {
			t.Errorf("the task %s is still registered", name)
		}
		// The server must be gone, or the temp folder cannot be removed.
		for i := 0; i < 20 && (answering("http://127.0.0.1:"+port) || answering("http://127.0.0.1:1"+port)); i++ {
			time.Sleep(250 * time.Millisecond)
		}
	})

	// Cold path: a first install.
	out := run()
	t.Logf("install:\n%s", out)
	base := "http://127.0.0.1:" + port
	if !answering(base) {
		t.Fatal("not answering after install")
	}
	if !strings.Contains(out, "registered to run at boot") || !strings.Contains(out, "dakort test1 runs as "+name) || !strings.Contains(out, "/login?token=") {
		t.Errorf("install output: %s", out)
	}
	if exec.Command("schtasks", "/Query", "/TN", name).Run() != nil {
		t.Error("the task is not registered")
	}
	token, err := os.ReadFile(filepath.Join(data, "token"))
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", base+"/api/sessions", nil)
	withToken(req, strings.TrimSpace(string(token)))
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 200 {
		t.Errorf("sessions with the token: %v %v", err, resp)
	}
	wrapper, _ := os.ReadFile(filepath.Join(home, "start.cmd"))
	if !strings.Contains(string(wrapper), "-data "+data) && !strings.Contains(string(wrapper), `-data "`+data+`"`) {
		t.Errorf("the wrapper lacks the data folder: %s", wrapper)
	}

	// Hot path: a new build is staged and the server restarts with it.
	exe2 := filepath.Join(t.TempDir(), "dakort.exe")
	if out, err := exec.Command("go", "build", "-ldflags", "-X main.version=test2", "-o", exe2, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	out2, err := exec.Command(exe2, common...).CombinedOutput()
	if err != nil {
		t.Fatalf("second setup: %v\n%s", err, out2)
	}
	t.Logf("update:\n%s", out2)
	if !strings.Contains(string(out2), "restarted with test2") {
		t.Errorf("update output: %s", out2)
	}
	if _, err := os.Stat(filepath.Join(home, "bin", "dakort.exe.new")); err == nil {
		t.Error("the staged build was not swapped in")
	}
	if got, _ := exec.Command(filepath.Join(home, "bin", "dakort.exe"), "-version").Output(); !strings.Contains(string(got), "test2") {
		t.Errorf("installed binary says %q", got)
	}
	logText, _ := os.ReadFile(filepath.Join(home, "logs", "server.log"))
	if !strings.Contains(string(logText), "exited with 75") || !strings.Contains(string(logText), "dakort test2") {
		t.Errorf("log lacks the restart:\n%s", logText)
	}

	// Running the installed binary's own setup stages nothing.
	out3, err := exec.Command(filepath.Join(home, "bin", "dakort.exe"), common...).CombinedOutput()
	if err != nil || !strings.Contains(string(out3), "is running this build") {
		t.Errorf("setup from the installed binary: %v %s", err, out3)
	}

	// Cold path over a running task: a changed definition (another port,
	// one character longer, so the old wrapper's offsets no longer fit)
	// stops the wrapper and the server, puts the new wrapper in and starts
	// again. Once, the old wrapper outlived the stop, read the rewritten
	// file from its old offset and started the old binary again.
	var cold []string
	for _, a := range common {
		if a == port {
			a = "1" + port
		}
		cold = append(cold, a)
	}
	out4, err := exec.Command(exe2, cold...).CombinedOutput()
	if err != nil || !strings.Contains(string(out4), "registered to run at boot") {
		t.Fatalf("cold reinstall: %v\n%s", err, out4)
	}
	if !answering("http://127.0.0.1:1"+port) || answering(base) {
		t.Errorf("after the cold reinstall: new port up=%v, old port up=%v", answering("http://127.0.0.1:1"+port), answering(base))
	}
	ps, _ := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-Process dakort -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '"+filepath.Join(home, "bin", "dakort.exe")+"' } | Measure-Object).Count").Output()
	if n := strings.TrimSpace(string(ps)); n != "1" {
		t.Errorf("%s servers run from the install folder, want 1", n)
	}
	if _, err := os.Stat(filepath.Join(home, "start.cmd.new")); err == nil {
		t.Error("the new wrapper was not moved in")
	}
}
