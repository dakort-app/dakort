// Command dakort is the Dakort server: one binary with the UI embedded.
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// Addresses after the first may not exist yet when the server starts (the
// Tailscale address appears only once Tailscale is up after boot), so they
// are retried this often instead of failing the start.
const relisten = 15 * time.Second

// restartCode is the exit code after POST /api/restart: the service then
// starts again with the staged build swapped in (the task's wrapper on
// Windows, swapStaged on macOS and Linux; dakort setup stages it).
const restartCode = 75

// version is set at build time from the git tag (-ldflags "-X
// main.version=v0.1.0"; .goreleaser.yaml and scripts/ship.sh do).
var version = "dev"

// oldName is what the config and cache folders were called before the
// app was named; a first start moves them over.
const oldName = "mini-ade-go"

func main() {
	// Subcommands: `dakort setup` (setup.go), `dakort update` (update.go).
	// No subcommand runs the server.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "setup":
			setupMain(os.Args[2:])
			return
		case "update":
			updateMain(os.Args[2:])
			return
		}
	}
	showVersion := flag.Bool("version", false, "print the version and exit")
	// Loopback, plus this machine's Tailscale addresses (-tailscale), which
	// is how the phone reaches it. Never all interfaces: anything beyond
	// loopback and the tailnet goes through -expose, on purpose.
	addr := flag.String("addr", "127.0.0.1:3002", "listen addresses, comma-separated, loopback or Tailscale only; the first must be available at start")
	tailnet := flag.Bool("tailscale", true, "also listen on this machine's Tailscale addresses, at the first address's port, once Tailscale is up")
	expose := flag.String("expose", "", "other listen addresses, comma-separated, reachable beyond this machine and the tailnet; the password is the only guard")
	service := flag.Bool("service", false, "running as a background task: log where the token is, never the token itself")
	// Off by default: a second server (a test one on 3003) compacting the
	// same sessions as the installed one would fork them.
	idleCompact := flag.Bool("idle-compact", false, "compact big sessions shortly before their prompt cache expires")
	// A test server (the browser checks on 3003) keeps its token, folder
	// list, settings and trash apart from the installed one's, or the two
	// would write the same files and the checks would open and close
	// folders on the real home screen.
	data := flag.String("data", "", "folder for the token, folder list, settings, trash and assets; the user's config and cache folders when empty")
	logPath := flag.String("log", "", "append the log to this file, rolled over at 5 MB (the macOS and Linux services; the Windows task's wrapper redirects instead)")
	flag.Parse()
	if *showVersion {
		fmt.Println("dakort", version)
		return
	}
	if *logPath != "" {
		if err := logTo(*logPath); err != nil {
			log.Fatal(err)
		}
	}
	if *service {
		swapStaged()
	}
	log.Printf("dakort %s", version)

	addrs := splitAddrs(*addr)
	if len(addrs) == 0 {
		log.Fatal("-addr: no address")
	}
	for _, a := range addrs {
		if err := private(a); err != nil {
			log.Fatalf("-addr %s: %v", a, err)
		}
	}
	exposed := splitAddrs(*expose)

	cfg, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		log.Fatal(err)
	}
	if *data != "" {
		cfg, cache = *data, *data
	} else {
		cfg, cache = moved(cfg, "dakort"), moved(cache, "dakort")
	}
	tokenPath := filepath.Join(cfg, "token")
	token, err := server.LoadToken(tokenPath)
	if err != nil {
		log.Fatal(err)
	}

	idx := index.New()
	start := time.Now()
	if _, err := idx.Refresh(); err != nil {
		log.Fatal(err)
	}
	log.Printf("indexed %d sessions in %v", len(idx.List()), time.Since(start).Round(time.Millisecond))

	var s *server.Server
	s = server.New(server.Config{
		Token:      token,
		Index:      idx,
		Assets:     transcript.Dir(filepath.Join(cache, "assets")),
		Folders:    filepath.Join(cfg, "folders.json"),
		Moves:      filepath.Join(cfg, "moves.json"),
		Seen:       filepath.Join(cfg, "seen.json"),
		Tabs:       filepath.Join(cfg, "tabs.json"),
		Password:   filepath.Join(cfg, "password.json"),
		Trash:      filepath.Join(cache, "trash"),
		Settings:   filepath.Join(cfg, "sessions.json"),
		Compact:    server.CompactConfig{On: *idleCompact},
		Release:    server.ReleaseConfig{On: true},
		WarmModels: true,
		Version:    version,
		Restart: func() {
			s.Close()
			os.Exit(restartCode)
		},
	})
	defer s.Close()
	srv := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: the event stream (4b) stays open indefinitely.
	}
	ln, err := net.Listen("tcp", addrs[0])
	if err != nil {
		log.Fatal(err)
	}
	announce(ln, token, tokenPath, *service)
	for _, a := range addrs[1:] {
		go listenLater(srv, a, token, tokenPath, *service)
	}
	for _, a := range exposed {
		log.Printf("WARNING: -expose %s: anyone who can reach this address gets the login page, and the password is all that stands between them and running commands on this machine as you (five wrong passwords close the login for five minutes)", a)
		go listenLater(srv, a, token, tokenPath, *service)
	}
	if *tailnet {
		_, port, _ := net.SplitHostPort(ln.Addr().String())
		go listenTailnet(srv, port, append(addrs, exposed...))
	}
	log.Fatal(srv.Serve(ln))
}

// moved returns the app's folder under root, after moving the one from
// before the name change there, once: the token, password, folder list and
// rename record (config), the assets and trash (cache) carry on. The whole
// folder when the new one is not there yet; else (the installer makes bin
// and logs under the cache one first) entry by entry, each the new folder
// lacks. What cannot be moved yet (the old server still has it open) stays,
// is logged, and is tried again next start.
func moved(root, name string) string {
	dir, old := filepath.Join(root, name), filepath.Join(root, oldName)
	entries, err := os.ReadDir(old)
	if err != nil {
		return dir // nothing from before
	}
	if _, err := os.Stat(dir); err != nil {
		if err := os.Rename(old, dir); err == nil {
			log.Printf("moved %s to %s", old, dir)
			return dir
		}
		os.MkdirAll(dir, 0o700)
	}
	for _, e := range entries {
		src, dst := filepath.Join(old, e.Name()), filepath.Join(dir, e.Name())
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		if err := os.Rename(src, dst); err != nil {
			log.Printf("could not move %s to %s yet: %v", src, dst, err)
			continue
		}
		log.Printf("moved %s to %s", src, dst)
	}
	os.Remove(old) // only once empty
	return dir
}

// logTo sends the log to a file, rolled over to .old when it has grown
// past serviceLogRoll at a start.
func logTo(path string) error {
	if fi, err := os.Stat(path); err == nil && fi.Size() > serviceLogRoll {
		os.Rename(path, path+".old")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	log.SetOutput(f)
	os.Stdout, os.Stderr = f, f
	return nil
}

func splitAddrs(s string) []string {
	var out []string
	for _, a := range strings.Split(s, ",") {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	return out
}

// private refuses an -addr reachable beyond this machine and the tailnet:
// an empty host or 0.0.0.0 is every interface, the local network included
// (the fork binds that way, which is why it needs the network trusted).
func private(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || isTailscaleIP(ip)) {
		return nil
	}
	return errors.New("not a loopback or Tailscale address; use -expose to listen there on purpose")
}

// listenTailnet waits for Tailscale to be installed and up, then serves on
// this machine's Tailscale addresses at port, and does so again if
// Tailscale goes away and comes back. Addresses already listened on are
// skipped. Installed later (after dakort setup, as the setup output
// suggests) it is found at its usual place within relisten, no restart.
func listenTailnet(srv *http.Server, port string, taken []string) {
	bin, err := tailscaleBin()
	for told := false; err != nil; bin, err = tailscaleBin() {
		if !told {
			log.Printf("no Tailscale here: listening on this machine only until it is installed (install Tailscale to reach it from a phone)")
			told = true
		}
		time.Sleep(relisten)
	}
	for warned := false; ; time.Sleep(relisten) {
		name, ips, err := tailscaleSelf(bin)
		if err != nil || len(ips) == 0 {
			if !warned {
				log.Printf("Tailscale is not up yet (%v); asking again every %v", err, relisten)
				warned = true
			}
			continue
		}
		warned = false
		var lns []net.Listener
		var shown []string
		failed := false
		for _, ip := range ips {
			a := net.JoinHostPort(ip.String(), port)
			if slices.Contains(taken, a) {
				continue
			}
			ln, err := net.Listen("tcp", a)
			if err != nil {
				log.Printf("cannot listen on %s: %v", a, err)
				failed = true
				continue
			}
			lns = append(lns, ln)
			shown = append(shown, "http://"+a)
		}
		if len(lns) == 0 {
			if failed {
				continue
			}
			return // all in -addr already
		}
		// The scheme is part of the address: a bare name:port typed into a
		// browser is searched for instead.
		if name != "" {
			shown = append([]string{"http://" + net.JoinHostPort(name, port)}, shown...)
		}
		log.Printf("on the tailnet (log in with the password): %s", strings.Join(shown, " or "))
		done := make(chan struct{}, len(lns))
		for _, ln := range lns {
			go func() {
				if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
					log.Printf("serving %s: %v", ln.Addr(), err)
				}
				done <- struct{}{}
			}()
		}
		// One address failing (Tailscale stopped, the address changed):
		// close the others and start over once Tailscale is back.
		<-done
		for _, ln := range lns {
			ln.Close()
		}
		for range len(lns) - 1 {
			<-done
		}
	}
}

// listenLater keeps trying an address until it can listen on it, then
// serves there too.
func listenLater(srv *http.Server, addr, token, tokenPath string, service bool) {
	for warned := false; ; warned = true {
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			announce(ln, token, tokenPath, service)
			if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
				log.Printf("serving %s: %v", addr, err)
			}
			return
		}
		if !warned {
			log.Printf("cannot listen on %s yet (%v); retrying every %v", addr, err, relisten)
		}
		time.Sleep(relisten)
	}
}

// announce prints the login link. As a service the output goes to a log
// file, so the link names the token file instead of carrying the token.
func announce(ln net.Listener, token, tokenPath string, service bool) {
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	if ip := net.ParseIP(host); ip == nil || ip.IsUnspecified() {
		host = "localhost"
	}
	base := "http://" + net.JoinHostPort(host, port)
	if service {
		log.Printf("listening on %s; log in at %s/login?token=<the token in %s>", base, base, tokenPath)
		return
	}
	fmt.Printf("login: %s/login?token=%s\n(token kept in %s)\n", base, token, tokenPath)
}
