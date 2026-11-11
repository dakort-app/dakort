package main

import (
	"errors"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
)

// autoUpdater is what the server runs to install a newer release by
// itself (internal/server/release.go): this same program's `update`
// command, which fetches the release, checks it against the release's
// sums, stages it beside the installed copy and asks the server to
// restart once nothing runs. Its printout goes to the log.
func autoUpdater(addr, data string) func(tag string) error {
	return func(tag string) error {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		_, port, err := net.SplitHostPort(addr)
		if err != nil {
			return err
		}
		args := []string{"update", "-port", port, "-tag", tag}
		if data != "" {
			args = append(args, "-data", data)
		}
		out, err := exec.Command(exe, args...).CombinedOutput()
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if line = strings.TrimSpace(line); line != "" {
				log.Printf("update: %s", line)
			}
		}
		if err != nil {
			return errors.New(strings.TrimSpace(string(out)))
		}
		return nil
	}
}

// installedVersion is what the service's own copy of the program says it
// is, empty when there is none or it is this very file.
func installedVersion() string {
	home, err := installDir()
	if err != nil {
		return ""
	}
	svc := newService(setupOpts{home: home, name: defaultServiceName})
	self, _ := os.Executable()
	if !exists(svc.exe()) || sameFile(self, svc.exe()) {
		return ""
	}
	out, err := exec.Command(svc.exe(), "-version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(strings.SplitN(string(out), "\n", 2)[0], "dakort "))
}
