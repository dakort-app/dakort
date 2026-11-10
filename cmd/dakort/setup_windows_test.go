package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestRealSetup installs a throwaway service (its own name, folder, data
// and port) with the real binary, restarts it through the hot path with a
// staged build, and removes it. Windows only so far. The login task needs
// no special rights; the -at-boot step runs only with administrator
// rights (a boot trigger needs them). CI skips it (-short).
func TestRealSetup(t *testing.T) {
	if testing.Short() {
		t.Skip("installs a real service")
	}
	const port = "3005"
	if ln, err := net.Listen("tcp", "127.0.0.1:"+port); err != nil {
		t.Skipf("port %s is taken", port)
	} else {
		ln.Close()
	}
	// A space in the path, as in most user folders: the temp folder is in
	// its short form, which has none, and the login task's command line once
	// broke on one.
	home := filepath.Join(t.TempDir(), "madetest-setup dir")
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
	if !strings.Contains(out, "registered to run from login") || !strings.Contains(out, "dakort test1 runs as "+name) || !strings.Contains(out, "/login?token=") {
		t.Errorf("install output: %s", out)
	}
	if exec.Command("schtasks", "/Query", "/TN", name).Run() != nil {
		t.Error("the task is not registered")
	}
	// In the user's session, under a headless console host: Codex's
	// sandbox needs the interactive desktop, and no window may show.
	if got := taskLogon(name); got != "Interactive" {
		t.Errorf("the task's logon type is %q, want Interactive", got)
	}
	if ps, _ := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-ScheduledTask -TaskName '"+name+"').Actions[0].Execute").Output(); !strings.Contains(strings.ToLower(string(ps)), "conhost") {
		t.Errorf("the task runs %q, want the headless console host", strings.TrimSpace(string(ps)))
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

	// dakort update, from a fake GitHub: the release's zip is fetched,
	// checked, its binary staged, and the server restarts with it.
	exe3 := filepath.Join(t.TempDir(), "dakort.exe")
	if out, err := exec.Command("go", "build", "-ldflags", "-X main.version=v0.0.3-test", "-o", exe3, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	bin3, _ := os.ReadFile(exe3)
	archive, archiveName := pack(t, bin3, "0.0.3-test")
	sum := sha256.Sum256(archive)
	gh := fakeGitHub(t, "v0.0.3-test", archive, archiveName, hex.EncodeToString(sum[:])+"  "+archiveName+"\n")
	outU, err := exec.Command(filepath.Join(home, "bin", "dakort.exe"), "update", "-tag", "v0.0.3-test", "-api", gh.URL,
		"-name", name, "-home", home, "-data", data, "-port", port).CombinedOutput()
	t.Logf("dakort update:\n%s", outU)
	if err != nil || !strings.Contains(string(outU), "restarted with v0.0.3-test") {
		logText, _ := os.ReadFile(filepath.Join(home, "logs", "server.log"))
		t.Errorf("dakort update: %v %s\nserver log:\n%s", err, outU, logText)
	}
	if _, err := os.Stat(filepath.Join(home, "bin", "dakort.exe.new")); err == nil {
		t.Error("the fetched build was not swapped in")
	}
	if got, _ := exec.Command(filepath.Join(home, "bin", "dakort.exe"), "-version").Output(); !strings.Contains(string(got), "v0.0.3-test") {
		t.Errorf("installed binary says %q after update", got)
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
	if err != nil || !strings.Contains(string(out4), "registered to run from login") {
		t.Fatalf("cold reinstall: %v\n%s", err, out4)
	}
	if !answering("http://127.0.0.1:1"+port) || answering(base) {
		t.Errorf("after the cold reinstall: new port up=%v, old port up=%v", answering("http://127.0.0.1:1"+port), answering(base))
	}
	if n := serversFrom(home); n != "1" {
		t.Errorf("%s servers run from the install folder, want 1", n)
	}
	if _, err := os.Stat(filepath.Join(home, "start.cmd.new")); err == nil {
		t.Error("the new wrapper was not moved in")
	}

	// -at-boot: the task is registered again (the wrapper says where it
	// runs, so this is the cold path) with the boot trigger and S4U logon,
	// which only an elevated test can do without a prompt.
	if elevated() {
		out5, err := exec.Command(exe2, append(cold, "-at-boot")...).CombinedOutput()
		if err != nil || !strings.Contains(string(out5), "registered to run at boot") {
			t.Fatalf("reinstall at boot: %v\n%s", err, out5)
		}
		if got := taskLogon(name); got != "S4U" {
			t.Errorf("the task's logon type is %q after -at-boot, want S4U", got)
		}
		if !answering("http://127.0.0.1:1" + port) {
			t.Error("not answering after the reinstall at boot")
		}
		if n := serversFrom(home); n != "1" {
			t.Errorf("%s servers run from the install folder after -at-boot, want 1", n)
		}
	} else {
		t.Log("not elevated: the -at-boot step is skipped")
	}

	// The fallback when the service does not bring the server up: with
	// the task gone, startDirect runs the wrapper detached, the server
	// answers, and the next cold step (here a removal) ends it.
	run("-uninstall")
	if answering("http://127.0.0.1:1" + port) {
		t.Fatal("still answering after the uninstall")
	}
	p, _ := strconv.Atoi("1" + port)
	svc := newService(setupOpts{port: p, home: home, data: data, name: name})
	if err := svc.startDirect(); err != nil {
		t.Fatalf("startDirect: %v", err)
	}
	if !waitUp("http://127.0.0.1:1" + port) {
		t.Error("not answering after startDirect")
	}
	if err := svc.remove(); err != nil {
		t.Errorf("remove after startDirect: %v", err)
	}
	for i := 0; i < 20 && answering("http://127.0.0.1:1"+port); i++ {
		time.Sleep(250 * time.Millisecond)
	}
	if n := serversFrom(home); n != "0" {
		t.Errorf("%s servers run from the install folder after the removal, want 0", n)
	}
}

// taskLogon is the scheduled task's logon type: Interactive (the user's
// session) or S4U (session 0, at boot).
func taskLogon(name string) string {
	out, _ := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-ScheduledTask -TaskName '"+name+"').Principal.LogonType").Output()
	return strings.TrimSpace(string(out))
}

// serversFrom counts the dakort processes running from home's bin folder.
func serversFrom(home string) string {
	ps, _ := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-Process dakort -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '"+filepath.Join(home, "bin", "dakort.exe")+"' } | Measure-Object).Count").Output()
	return strings.TrimSpace(string(ps))
}
