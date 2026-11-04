package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// On Linux the service is a systemd user unit (~/.config/systemd/user),
// enabled so it starts with the user's session and, with lingering on,
// at boot before anyone logs in. Restart=always makes an exit with code
// 75 after POST /api/restart a restart, and the server swaps a staged
// build in over itself as it starts (swap_other.go). The install folder
// is the user's data one (XDG_DATA_HOME, ~/.local/share).

const defaultServiceName = "dakort"

func installDir() (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "dakort"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "dakort"), nil
}

type systemdService struct{ o setupOpts }

func newService(o setupOpts) service { return systemdService{o} }

func (s systemdService) bin() string    { return filepath.Join(s.o.home, "bin") }
func (s systemdService) logs() string   { return filepath.Join(s.o.home, "logs") }
func (s systemdService) exe() string    { return filepath.Join(s.bin(), "dakort") }
func (s systemdService) staged() string { return s.exe() + ".new" }
func (s systemdService) log() string    { return filepath.Join(s.logs(), "server.log") }
func (s systemdService) unit() string {
	root, err := os.UserConfigDir()
	if err != nil {
		root = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(root, "systemd", "user", s.o.name+".service")
}

// unitQuote quotes a word for a unit file's command line.
func unitQuote(a string) string {
	if !strings.ContainsAny(a, " \t\"'\\") {
		return a
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(a) + `"`
}

func (s systemdService) definition() string {
	var args []string
	for _, a := range append(append([]string{s.exe()}, s.o.serverArgs()...), "-log", s.log()) {
		args = append(args, unitQuote(a))
	}
	return `# Written by dakort setup.
[Unit]
Description=Dakort: Claude Code and Codex on your phone
After=network-online.target

[Service]
ExecStart=` + strings.Join(args, " ") + `
Environment=` + unitQuote("PATH="+servicePATH()) + `
WorkingDirectory=` + unitQuote(s.o.home) + `
Restart=always
RestartSec=1

[Install]
WantedBy=default.target
`
}

func (s systemdService) installed() bool { return exists(s.unit()) }

func (s systemdService) running() bool {
	return exec.Command("systemctl", "--user", "is-active", "--quiet", s.o.name).Run() == nil
}

func (s systemdService) unchanged() bool {
	cur, err := os.ReadFile(s.unit())
	return err == nil && sameDefinition(string(cur), s.definition())
}

func systemctl(args ...string) error {
	out, err := exec.Command("systemctl", append([]string{"--user"}, args...)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl --user %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s systemdService) install() error {
	if err := os.MkdirAll(filepath.Dir(s.unit()), 0o755); err != nil {
		return err
	}
	if s.installed() {
		systemctl("stop", s.o.name)
	}
	if exists(s.staged()) {
		if err := os.Rename(s.staged(), s.exe()); err != nil {
			return err
		}
	}
	if err := os.WriteFile(s.unit(), []byte(s.definition()), 0o644); err != nil {
		return err
	}
	if err := systemctl("daemon-reload"); err != nil {
		return err
	}
	if err := systemctl("enable", "--now", s.o.name); err != nil {
		return err
	}
	if err := systemctl("restart", s.o.name); err != nil {
		return err
	}
	// Lingering keeps the user's services running with nobody logged in,
	// so the phone reaches the app after a reboot.
	if out, err := exec.Command("loginctl", "enable-linger").CombinedOutput(); err != nil {
		fmt.Printf("%s enabled; it starts when you log in. To have it run at boot before you log in: sudo loginctl enable-linger %s (%s)\n",
			s.o.name, os.Getenv("USER"), strings.TrimSpace(string(out)))
	} else {
		fmt.Printf("%s enabled; it starts at boot\n", s.o.name)
	}
	return nil
}

func (s systemdService) remove() error {
	if !s.installed() {
		return nil
	}
	systemctl("disable", "--now", s.o.name)
	if err := os.Remove(s.unit()); err != nil {
		return err
	}
	return systemctl("daemon-reload")
}

func consoleReady() {}
