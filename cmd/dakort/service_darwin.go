package main

import (
	"fmt"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// On macOS the service is a launchd agent of the user's (a plist under
// ~/Library/LaunchAgents, loaded into the user's session with launchctl
// bootstrap): started at login, kept alive, so an exit with code 75 after
// POST /api/restart is a restart, and the server swaps a staged build in
// over itself as it starts (swap_other.go). The install folder is the
// user's Application Support one; Caches may be emptied by the system.

const defaultServiceName = "app.dakort"

func installDir() (string, error) {
	root, err := os.UserConfigDir() // ~/Library/Application Support
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "dakort"), nil
}

type macService struct{ o setupOpts }

func newService(o setupOpts) service { return macService{o} }

func (s macService) bin() string    { return filepath.Join(s.o.home, "bin") }
func (s macService) logs() string   { return filepath.Join(s.o.home, "logs") }
func (s macService) exe() string    { return filepath.Join(s.bin(), "dakort") }
func (s macService) staged() string { return s.exe() + ".new" }
func (s macService) log() string    { return filepath.Join(s.logs(), "server.log") }
func (s macService) plist() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", s.o.name+".plist")
}

func (s macService) definition() string {
	var args []string
	for _, a := range append([]string{s.exe()}, s.o.serverArgs()...) {
		args = append(args, "\t\t<string>"+html.EscapeString(a)+"</string>")
	}
	args = append(args, "\t\t<string>-log</string>", "\t\t<string>"+html.EscapeString(s.log())+"</string>")
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + html.EscapeString(s.o.name) + `</string>
	<key>ProgramArguments</key>
	<array>
` + strings.Join(args, "\n") + `
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>` + html.EscapeString(servicePATH()) + `</string>
	</dict>
	<key>WorkingDirectory</key>
	<string>` + html.EscapeString(s.o.home) + `</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
`
}

func (s macService) installed() bool { return exists(s.plist()) }

func (s macService) running() bool {
	return exec.Command("launchctl", "print", s.domain()+"/"+s.o.name).Run() == nil
}

func (s macService) unchanged() bool {
	cur, err := os.ReadFile(s.plist())
	return err == nil && sameDefinition(string(cur), s.definition())
}

func (s macService) domain() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

func (s macService) install() error {
	if err := os.MkdirAll(filepath.Dir(s.plist()), 0o755); err != nil {
		return err
	}
	// Unload first: a loaded agent is restarted by launchd the moment its
	// process ends, and the swap must happen while nothing runs it.
	exec.Command("launchctl", "bootout", s.domain()+"/"+s.o.name).Run()
	if exists(s.staged()) {
		if err := os.Rename(s.staged(), s.exe()); err != nil {
			return err
		}
	}
	if err := os.WriteFile(s.plist(), []byte(s.definition()), 0o644); err != nil {
		return err
	}
	if out, err := exec.Command("launchctl", "bootstrap", s.domain(), s.plist()).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap: %v: %s", err, strings.TrimSpace(string(out)))
	}
	fmt.Printf("%s loaded; it starts at every login\n", s.o.name)
	return nil
}

func (s macService) remove() error {
	if !s.installed() {
		return nil
	}
	exec.Command("launchctl", "bootout", s.domain()+"/"+s.o.name).Run()
	return os.Remove(s.plist())
}

func consoleReady() {}
