package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dakort-app/dakort/internal/server"
)

// dakort update fetches the latest release from GitHub, checks it against
// the release's checksums, stages it beside the installed binary and asks
// the running server to restart with it once no turn runs: the hand-over
// dakort setup does with a new build. Nothing is cut off. A service that
// is not running takes the staged build at its next start.
//
//	dakort update                   the latest release, when newer than this build
//	dakort update -pre              a release candidate counts too
//	dakort update -tag v0.2.0-rc1   that release, newer or not
//	dakort update -check            only say what is out
//
// The page says "v0.2.0 is out" once the server has heard of it
// (internal/server/release.go); this is the line it points to. While the
// repo is private the GitHub API wants a token (GITHUB_TOKEN or
// DAKORT_GITHUB_TOKEN); public, it needs none.
type updateOpts struct {
	port  int
	home  string
	data  string
	name  string
	pre   bool
	tag   string
	check bool

	api  string // the GitHub API's base; api.github.com when empty (tests)
	repo string // owner/name (tests)
}

const (
	releaseRepo = "dakort-app/dakort"
	releaseAPI  = "https://api.github.com"
)

func updateMain(args []string) {
	fs := flag.NewFlagSet("dakort update", flag.ExitOnError)
	var o updateOpts
	fs.IntVar(&o.port, "port", 3002, "the port the service listens on")
	fs.StringVar(&o.home, "home", "", "the install folder (default: the user's app folder)")
	fs.StringVar(&o.data, "data", "", "the server's data folder (default: the user's config folder)")
	fs.StringVar(&o.name, "name", "", "the service's name (default: Dakort)")
	fs.BoolVar(&o.pre, "pre", false, "take a release candidate too")
	fs.StringVar(&o.tag, "tag", "", "this release (v0.2.0-rc1), newer or not")
	fs.BoolVar(&o.check, "check", false, "only say what the latest release is")
	fs.StringVar(&o.api, "api", "", "internal: the GitHub API's base")
	fs.StringVar(&o.repo, "repo", "", "internal: the repo, owner/name")
	fs.Usage = func() {
		fmt.Fprint(fs.Output(), "usage: dakort update [flags]\n\nFetches the latest release and restarts the service with it once no turn runs.\n\n")
		fs.PrintDefaults()
	}
	fs.Parse(args)
	if err := update(o, os.Stdout); err != nil {
		fmt.Println("update failed:", err)
		os.Exit(1)
	}
}

type release struct {
	Tag    string  `json:"tag_name"`
	Draft  bool    `json:"draft"`
	Pre    bool    `json:"prerelease"`
	Assets []asset `json:"assets"`
}

type asset struct {
	Name string `json:"name"`
	URL  string `json:"url"` // the API's address for it; asked with Accept octet-stream it is the file, private repo or not
	Size int64  `json:"size"`
}

func update(o updateOpts, out io.Writer) error {
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
	if o.api == "" {
		o.api = releaseAPI
	}
	if o.repo == "" {
		o.repo = releaseRepo
	}
	svc := newService(setupOpts{port: o.port, home: o.home, data: o.data, name: o.name})
	if !exists(svc.exe()) {
		return fmt.Errorf("no installed Dakort at %s; run dakort setup first", svc.exe())
	}

	gh := github{api: o.api, repo: o.repo, token: githubToken()}
	rel, err := gh.release(o.tag, o.pre)
	if err != nil {
		return err
	}
	newer := server.NewerRelease(version, rel.Tag)
	if o.check {
		switch {
		case newer:
			fmt.Fprintf(out, "this is %s; %s is out\n", version, rel.Tag)
		default:
			fmt.Fprintf(out, "this is %s; the latest release is %s\n", version, rel.Tag)
		}
		return nil
	}
	if o.tag == "" && !newer {
		fmt.Fprintf(out, "this is %s; the latest release is %s, nothing to do\n", version, rel.Tag)
		return nil
	}

	// The archive for this system, checked against the release's sums.
	ext := "tar.gz"
	if runtime.GOOS == "windows" {
		ext = "zip"
	}
	name := fmt.Sprintf("dakort_%s_%s_%s.%s", strings.TrimPrefix(rel.Tag, "v"), runtime.GOOS, runtime.GOARCH, ext)
	a, ok := rel.asset(name)
	if !ok {
		return fmt.Errorf("%s has no %s", rel.Tag, name)
	}
	sums, ok := rel.asset("checksums.txt")
	if !ok {
		return fmt.Errorf("%s has no checksums.txt", rel.Tag)
	}
	want, err := gh.checksum(sums, name)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "fetching %s (%d MB)\n", name, (a.Size+500_000)/1_000_000)
	archive := filepath.Join(svc.bin(), name+".part")
	defer os.Remove(archive)
	if err := gh.download(a, archive, want); err != nil {
		return err
	}
	if err := extract(archive, svc.staged()); err != nil {
		return err
	}
	// The staged build must run here and be what it says, before the
	// server is asked to go down for it.
	said, err := exec.Command(svc.staged(), "-version").Output()
	if err != nil || !strings.Contains(string(said), strings.TrimPrefix(rel.Tag, "v")) {
		os.Remove(svc.staged())
		return fmt.Errorf("the fetched build does not run here or is not %s (said %q; %v)", rel.Tag, strings.TrimSpace(string(said)), err)
	}

	// Hand it over, as setup does.
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
	base := fmt.Sprintf("http://127.0.0.1:%d", o.port)
	if !(svc.installed() && svc.running() && answering(base)) {
		fmt.Fprintf(out, "%s staged at %s; %s takes it at its next start\n", rel.Tag, svc.staged(), o.name)
		return nil
	}
	n, err := askRestart(base, token)
	if err != nil {
		return fmt.Errorf("asking the server to restart: %w", err)
	}
	handOver(out, svc, base, rel.Tag, n)
	return nil
}

// handOver says how the restart went: at once when no turn runs, else once
// the running ones finish.
func handOver(out io.Writer, svc service, base, what string, running int) {
	if running > 0 {
		fmt.Fprintf(out, "%s staged; the server restarts with it once %d running turn(s) finish\n", what, running)
		return
	}
	for i := 0; i < 60 && exists(svc.staged()); i++ {
		time.Sleep(500 * time.Millisecond)
	}
	for i := 0; i < 60 && !answering(base); i++ {
		time.Sleep(500 * time.Millisecond)
	}
	switch {
	case exists(svc.staged()):
		fmt.Fprintf(out, "the server has not swapped the build in yet; see %s\n", svc.log())
	case answering(base):
		fmt.Fprintf(out, "restarted with %s on %s; log: %s\n", what, base, svc.log())
	default:
		fmt.Fprintf(out, "swapped, but not answering yet; see %s\n", svc.log())
	}
}

func (r release) asset(name string) (asset, bool) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a, true
		}
	}
	return asset{}, false
}

// githubToken is the token the GitHub API is asked with, when one is set.
func githubToken() string {
	for _, k := range []string{"DAKORT_GITHUB_TOKEN", "GITHUB_TOKEN"} {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

type github struct {
	api, repo, token string
}

func (g github) get(url, accept string) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	if g.token != "" {
		// Dropped by the client on the redirect to the file store, as
		// it must be: that one carries its own signature.
		req.Header.Set("Authorization", "Bearer "+g.token)
	}
	c := &http.Client{Timeout: 10 * time.Minute}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
		resp.Body.Close()
		if resp.StatusCode == 404 && g.token == "" {
			return nil, fmt.Errorf("%s: %s (a private repo needs GITHUB_TOKEN)", url, resp.Status)
		}
		return nil, errors.New(url + ": " + resp.Status + ": " + strings.TrimSpace(string(body)))
	}
	return resp, nil
}

// release is the one asked for: a tag, the latest counting pre-releases,
// or the latest proper release as GitHub counts it.
func (g github) release(tag string, pre bool) (release, error) {
	var r release
	base := g.api + "/repos/" + g.repo + "/releases"
	switch {
	case tag != "":
		resp, err := g.get(base+"/tags/"+tag, "application/vnd.github+json")
		if err != nil {
			return r, err
		}
		defer resp.Body.Close()
		return r, decodeJSON(resp.Body, &r)
	case pre:
		resp, err := g.get(base+"?per_page=20", "application/vnd.github+json")
		if err != nil {
			return r, err
		}
		defer resp.Body.Close()
		var all []release
		if err := decodeJSON(resp.Body, &all); err != nil {
			return r, err
		}
		for _, x := range all {
			if !x.Draft {
				return x, nil
			}
		}
		return r, errors.New("no release yet")
	default:
		resp, err := g.get(base+"/latest", "application/vnd.github+json")
		if err != nil {
			return r, err
		}
		defer resp.Body.Close()
		return r, decodeJSON(resp.Body, &r)
	}
}

// checksum is the sum checksums.txt gives for the named file.
func (g github) checksum(sums asset, name string) (string, error) {
	resp, err := g.get(sums.URL, "application/octet-stream")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(body), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[1] == name {
			return f[0], nil
		}
	}
	return "", fmt.Errorf("checksums.txt has no line for %s", name)
}

// download fetches the asset to path and checks its sum on the way; a
// wrong sum leaves nothing behind.
func (g github) download(a asset, path, want string) error {
	resp, err := g.get(a.URL, "application/octet-stream")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(path)
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		os.Remove(path)
		return fmt.Errorf("%s does not match checksums.txt (got %s, want %s)", a.Name, got, want)
	}
	return nil
}

// extract takes the binary out of the archive (dakort.exe in a zip,
// dakort in a tar.gz) and puts it at dst, executable, through a temp
// name.
func extract(archive, dst string) error {
	bin := "dakort"
	if runtime.GOOS == "windows" {
		bin = "dakort.exe"
	}
	tmp := dst + ".tmp"
	var found bool
	write := func(r io.Reader) error {
		out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, r); err != nil {
			out.Close()
			os.Remove(tmp)
			return err
		}
		found = true
		return out.Close()
	}
	if strings.HasSuffix(archive, ".zip.part") || strings.HasSuffix(archive, ".zip") {
		z, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer z.Close()
		for _, f := range z.File {
			if filepath.Base(f.Name) != bin || f.FileInfo().IsDir() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			err = write(rc)
			rc.Close()
			if err != nil {
				return err
			}
			break
		}
	} else {
		f, err := os.Open(archive)
		if err != nil {
			return err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			if filepath.Base(h.Name) != bin || h.Typeflag != tar.TypeReg {
				continue
			}
			if err := write(tr); err != nil {
				return err
			}
			break
		}
	}
	if !found {
		return fmt.Errorf("%s has no %s in it", filepath.Base(archive), bin)
	}
	return os.Rename(tmp, dst)
}
