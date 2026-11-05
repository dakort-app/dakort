package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dakort-app/dakort/internal/claude"
	"github.com/dakort-app/dakort/internal/codex"
	"github.com/dakort-app/dakort/internal/server"
	"rsc.io/qr"
)

// dakort setup installs the server as a background service under the
// user's own account (a scheduled task that runs at boot on Windows, a
// launchd agent on macOS, a systemd user unit on Linux), then says how to
// reach it: the login link on this machine, the phone's address on the
// tailnet as a QR code, and which CLIs it found. The service runs a copy
// of this binary from the install folder (bin/dakort), so a package
// manager's update never writes over the running program.
//
// Run again after an update: the new binary is staged beside the running
// one and the server restarts with it once no turn runs (POST
// /api/restart; the Windows wrapper and the Unix self-swap at start do the
// swap). Nothing is cut off. A first install, or a change to the
// service's own definition, needs the service stopped and registered
// again, which waits for no turn to be running (or -force).
//
// The password is chosen in the browser, on this machine, the first time
// the page opens (the login page asks); the phone then logs in with it.
type setupOpts struct {
	port      int
	force     bool
	noBrowser bool
	https     bool
	httpsPort int
	uninstall bool
	home      string // the install folder: bin, logs, the service's files
	data      string // the server's -data, when not the user's config folder
	name      string // the task, agent or unit name

	// The elevated child on Windows: the cold path alone, its output to a
	// file the parent prints.
	step bool
	out  string
}

// serviceLogRoll is the size at which the service's log is rolled over
// (the Windows wrapper and -log do it).
const serviceLogRoll = 5_000_000

func setupMain(args []string) {
	fs := flag.NewFlagSet("dakort setup", flag.ExitOnError)
	var o setupOpts
	fs.IntVar(&o.port, "port", 3002, "the port, on this machine and on the tailnet")
	fs.BoolVar(&o.force, "force", false, "stop the service even while turns are running")
	fs.BoolVar(&o.noBrowser, "no-browser", false, "do not open the browser once the service is up")
	fs.BoolVar(&o.https, "https", false, "also put it behind Tailscale Serve, for HTTPS on the tailnet (needs HTTPS certificates enabled for the tailnet)")
	fs.IntVar(&o.httpsPort, "https-port", 443, "the HTTPS port for -https")
	fs.BoolVar(&o.uninstall, "uninstall", false, "stop and remove the service; the files, token and sessions stay")
	fs.StringVar(&o.home, "home", "", "the install folder (default: the user's app folder)")
	fs.StringVar(&o.data, "data", "", "the server's data folder (default: the user's config folder)")
	fs.StringVar(&o.name, "name", "", "the service's name (default: Dakort)")
	fs.BoolVar(&o.step, "install-step", false, "internal: the elevated install step")
	fs.StringVar(&o.out, "out", "", "internal: write the output here")
	fs.Usage = func() {
		fmt.Fprint(fs.Output(), "usage: dakort setup [flags]\n\nInstalls Dakort as a background service that runs at boot and shows how to reach it.\nRun it again after an update: the server restarts with the new build once no turn runs.\n\n")
		fs.PrintDefaults()
	}
	fs.Parse(args)
	if o.out != "" {
		f, err := os.OpenFile(o.out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			log.Fatal(err)
		}
		defer f.Close()
		os.Stdout, os.Stderr = f, f
		log.SetOutput(f)
	}
	if err := setup(o); err != nil {
		fmt.Println("setup failed:", err)
		os.Exit(1)
	}
}

func setup(o setupOpts) error {
	consoleReady()
	if o.home == "" {
		d, err := installDir()
		if err != nil {
			return err
		}
		o.home = d
	}
	if o.name == "" {
		o.name = defaultServiceName
	}
	svc := newService(o)
	if o.uninstall {
		if err := svc.remove(); err != nil {
			return err
		}
		fmt.Printf("%s removed; the files under %s, the token and the sessions stay\n", o.name, o.home)
		return nil
	}
	if o.step {
		return svc.install()
	}

	for _, d := range []string{svc.bin(), svc.logs()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	cfg := o.data
	if cfg == "" {
		root, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		cfg = moved(root, "dakort")
	}
	token, err := server.LoadToken(filepath.Join(cfg, "token"))
	if err != nil {
		return err
	}

	// Stage a copy of this binary, unless this is the installed one.
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	staged := false
	if !sameFile(exe, svc.exe()) {
		if err := copyFile(exe, svc.staged()); err != nil {
			return err
		}
		staged = true
	}

	base := fmt.Sprintf("http://127.0.0.1:%d", o.port)
	up := answering(base)
	if svc.installed() && svc.running() && svc.unchanged() && up && !o.force {
		// Hot path: the server restarts itself once idle and the new
		// build is swapped in on the way. Only with the service manager
		// running it: a server left on its own (once, by a wrapper that
		// died) would exit and not come back.
		if !staged {
			fmt.Printf("%s is running this build on %s\n", o.name, base)
			return nil
		}
		n, err := askRestart(base, token)
		if err != nil {
			return fmt.Errorf("asking the server to restart: %w", err)
		}
		handOver(os.Stdout, svc, base, version, n)
		return nil
	}

	// Cold path: stop, swap, register, start. Not over running turns.
	if up && !o.force {
		if n := runningTurns(base, token); n > 0 {
			return fmt.Errorf("the service must be stopped to install this, and %d turn(s) are running; run again when they finish (or -force)", n)
		}
	}
	if err := svc.install(); err != nil {
		return err
	}
	up = false
	for i := 0; i < 40 && !up; i++ {
		time.Sleep(500 * time.Millisecond)
		up = answering(base)
	}
	if !up {
		return fmt.Errorf("%s is registered but not answering on %s yet; see %s", o.name, base, svc.log())
	}
	report(o, svc, base, token)
	return nil
}

// report says where the server is and what it found, after a cold install.
func report(o setupOpts, svc service, base, token string) {
	fmt.Printf("dakort %s runs as %s on %s (log: %s)\n", version, o.name, base, svc.log())
	if p, err := claude.FindBinary(); err == nil {
		fmt.Println("claude:", p)
	} else {
		fmt.Println("claude: not found; install it from https://claude.com/claude-code and sign in, then run dakort setup again")
	}
	if p, err := codex.FindBinary(); err == nil {
		fmt.Println("codex:", p)
	} else {
		fmt.Println("codex: not found (optional); npm install -g @openai/codex, then codex login")
	}

	login := fmt.Sprintf("%s/login?token=%s", base, token)
	fmt.Printf("\nOn this machine: %s\n(the page asks you to choose a password the first time; the phone logs in with it)\n", login)
	if ts, err := tailscaleBin(); err != nil {
		fmt.Println("\nNo Tailscale here: the app is on this machine only. Install Tailscale on this machine and the phone (https://tailscale.com/download), sign both in, and run dakort setup again for the phone's address.")
	} else if name, _, err := tailscaleSelf(ts); err != nil || name == "" {
		fmt.Printf("\nTailscale is installed but not up (%v); once it is, the phone reaches the app at http://<this machine's tailnet name>:%d/\n", err, o.port)
	} else {
		phone := fmt.Sprintf("http://%s:%d/", name, o.port)
		if o.https {
			cmd := exec.Command(ts, "serve", "--bg", fmt.Sprintf("--https=%d", o.httpsPort), base)
			if out, err := cmd.CombinedOutput(); err != nil {
				fmt.Printf("tailscale serve failed (are HTTPS certificates enabled for the tailnet?): %s\n", strings.TrimSpace(string(out)))
			} else {
				phone = fmt.Sprintf("https://%s:%d/", name, o.httpsPort)
			}
		}
		fmt.Printf("\nOn the phone (with Tailscale signed in to the same account): %s\n", phone)
		if lines, err := qrLines(phone); err == nil {
			fmt.Println()
			for _, l := range lines {
				fmt.Println("  " + l)
			}
		}
	}
	if !o.noBrowser {
		openBrowser(login)
	}
}

// qrLines draws a QR code for a terminal, two modules per line in block
// characters, dark on a light background whatever the terminal's colours.
func qrLines(text string) ([]string, error) {
	c, err := qr.Encode(text, qr.M)
	if err != nil {
		return nil, err
	}
	const quiet = 2
	n := c.Size + 2*quiet
	black := func(x, y int) bool {
		x, y = x-quiet, y-quiet
		return x >= 0 && y >= 0 && x < c.Size && y < c.Size && c.Black(x, y)
	}
	var lines []string
	for y := 0; y < n; y += 2 {
		var b strings.Builder
		b.WriteString("\x1b[30;47m")
		for x := 0; x < n; x++ {
			top, bottom := black(x, y), y+1 < n && black(x, y+1)
			switch {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteString(" ")
			}
		}
		b.WriteString("\x1b[0m")
		lines = append(lines, b.String())
	}
	return lines, nil
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Println("could not open the browser:", err)
	}
}

// answering reports whether a server is up at base (401 is up: it wants
// the login cookie).
func answering(base string) bool {
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(base + "/")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200 || resp.StatusCode == 401
}

func withToken(req *http.Request, token string) {
	req.AddCookie(&http.Cookie{Name: "made_token", Value: token})
}

// runningTurns asks the server how many turns are running; 0 when it
// cannot be asked.
func runningTurns(base, token string) int {
	c := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest("GET", base+"/api/sessions", nil)
	withToken(req, token)
	resp, err := c.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	var sessions []struct {
		Running bool `json:"running"`
	}
	if err := decodeJSON(resp.Body, &sessions); err != nil {
		return 0
	}
	n := 0
	for _, s := range sessions {
		if s.Running {
			n++
		}
	}
	return n
}

// askRestart asks the server to restart once idle and returns how many
// turns it waits for.
func askRestart(base, token string) (int, error) {
	c := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("POST", base+"/api/restart", nil)
	withToken(req, token)
	resp, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return 0, errors.New(resp.Status + ": " + strings.TrimSpace(string(body)))
	}
	var r struct {
		Running int `json:"running"`
	}
	if err := decodeJSON(resp.Body, &r); err != nil {
		return 0, err
	}
	return r.Running, nil
}

func decodeJSON(r io.Reader, v any) error {
	return json.NewDecoder(r).Decode(v)
}

// service is the background service on this system (service_*.go).
type service interface {
	bin() string    // the folder the running binary lives in
	logs() string   // the log folder
	exe() string    // the installed binary
	staged() string // where a new build waits
	log() string    // the server's log
	installed() bool
	running() bool   // the service manager has it running (a server without it would not come back from a restart)
	unchanged() bool // the definition on disk is what install would write
	install() error  // write the definition, stop, swap the staged build in, register, start
	remove() error   // stop and unregister
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func sameFile(a, b string) bool {
	fa, err := os.Stat(a)
	if err != nil {
		return false
	}
	fb, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(fa, fb)
}

// copyFile writes src to dst, executable, through a temp name so a
// half-written file is never taken for a build.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// servicePATH is the PATH the service gets: the one this command was run
// with, so the CLIs and the tools they use (git, node, LaTeX) are found by
// the service as they are from the terminal (a service gets a bare PATH
// of its own otherwise).
func servicePATH() string {
	return os.Getenv("PATH")
}

// sameDefinition compares a service definition on disk with the one setup
// would write, PATH aside: every shell has a PATH of its own (a ship from
// inside a turn runs under Git Bash, the user's terminal is PowerShell),
// and a definition that differed in that line alone made every update a
// cold install. The PATH is refreshed by a cold install (-force, or a
// first one).
func sameDefinition(onDisk, fresh string) bool {
	return stripPATH(onDisk) == stripPATH(fresh)
}

func stripPATH(def string) string {
	lines := strings.Split(def, "\n")
	var out []string
	skip := false
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if skip { // the plist's value line after <key>PATH</key>
			skip = false
			continue
		}
		if strings.Contains(t, "PATH=") {
			continue
		}
		if t == "<key>PATH</key>" {
			skip = true
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, "\n")
}

// serverArgs is the service's command line after the binary.
func (o setupOpts) serverArgs() []string {
	args := []string{"-service", "-idle-compact", "-addr", fmt.Sprintf("127.0.0.1:%d", o.port)}
	if o.data != "" {
		args = append(args, "-data", o.data)
	}
	return args
}
