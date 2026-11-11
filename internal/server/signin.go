package server

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// A sign-in from the page, when a turn failed because the CLI's login
// has lapsed (or never happened). The app runs the CLI's own login
// command with no terminal and shows what it prints: a link, and for
// Codex a one-time code. Both flows finish from any device, a phone
// included, as measured 2026-11-11:
//
//   - `claude auth login` prints "visit: https://claude.com/cai/oauth/..."
//     whose redirect is a code page on platform.claude.com, not localhost,
//     then waits on stdin with "Paste code here if prompted >". The code
//     the page shows is pasted into the app and written to the process.
//   - `codex login --device-auth` prints https://auth.openai.com/codex/device
//     and a code like CF8P-GG7JS (15 minutes), then polls and exits 0 by
//     itself once the code is typed on that page. Plain `codex login`
//     wants a redirect to localhost:1455, no good from a phone.
//
// One sign-in per CLI at a time; a run is killed after signInMax. The
// next turn starts a fresh CLI process, which reads the new login.

const signInMax = 15 * time.Minute

// signInWait is how long POST /api/signin waits for the link to appear.
const signInWait = 15 * time.Second

type signIns struct {
	mu   sync.Mutex
	runs map[string]*signInRun
	env  []string // added to the login command's environment (tests point the config folders elsewhere)
}

type signInRun struct {
	cli     string
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	cancel  context.CancelFunc
	started time.Time

	mu     sync.Mutex
	out    strings.Builder // everything printed, ANSI colours stripped
	url    string
	code   string
	done   bool
	ok     bool
	errMsg string
	pasted bool
}

// signInState is what the page sees.
type signInState struct {
	CLI       string `json:"cli"`
	State     string `json:"state"` // starting, waiting, done, failed
	URL       string `json:"url,omitempty"`
	Code      string `json:"code,omitempty"`      // Codex: the one-time code to type on the page
	PasteCode bool   `json:"pasteCode,omitempty"` // Claude: the page hands back a code to paste here
	Error     string `json:"error,omitempty"`
}

var (
	ansiSeq    = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
	signInURL  = regexp.MustCompile(`https://\S+`)
	deviceCode = regexp.MustCompile(`^[A-Z0-9]{4,}-[A-Z0-9]{4,}$`)
)

func (r *signInRun) state() signInState {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := signInState{CLI: r.cli, URL: r.url, Code: r.code, PasteCode: r.cli == "claude" && !r.pasted}
	switch {
	case r.done && r.ok:
		st.State = "done"
	case r.done:
		st.State = "failed"
		st.Error = r.errMsg
	case r.url != "":
		st.State = "waiting"
	default:
		st.State = "starting"
	}
	return st
}

// read follows the command's output, picking the link and Codex's code
// out of it.
func (r *signInRun) read(out io.Reader) {
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(ansiSeq.ReplaceAllString(sc.Text(), ""))
		r.mu.Lock()
		r.out.WriteString(line + "\n")
		if r.url == "" {
			if m := signInURL.FindString(line); m != "" {
				r.url = m
			}
		}
		if r.cli == "codex" && r.code == "" && deviceCode.MatchString(line) {
			r.code = line
		}
		r.mu.Unlock()
	}
}

// finish records the exit. The output's last lines are the error when it
// failed: the CLI says why in words.
func (r *signInRun) finish(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.done = true
	r.ok = err == nil
	if err != nil {
		tail := strings.TrimSpace(r.out.String())
		if i := strings.LastIndex(tail, "\n"); i >= 0 && len(tail)-i > 1 {
			tail = tail[i+1:]
		}
		if tail == "" || strings.HasPrefix(tail, "Paste code") {
			tail = err.Error()
		}
		r.errMsg = tail
	}
}

func (s *signIns) get(cli string) *signInRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs[cli]
}

// start runs the login command, or returns the run already going. A
// finished run is replaced.
func (s *signIns) start(cli, bin string) (*signInRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.runs[cli]; r != nil && !r.state().isOver() {
		return r, nil
	}
	if bin == "" {
		return nil, errors.New(cli + " is not installed")
	}
	var args []string
	switch cli {
	case "claude":
		args = []string{"auth", "login"}
	case "codex":
		args = []string{"login", "--device-auth"}
	default:
		return nil, errors.New("unknown cli " + cli)
	}
	ctx, cancel := context.WithTimeout(context.Background(), signInMax)
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), s.env...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	r := &signInRun{cli: cli, cmd: cmd, stdin: stdin, cancel: cancel, started: time.Now()}
	if s.runs == nil {
		s.runs = map[string]*signInRun{}
	}
	s.runs[cli] = r
	go func() {
		r.read(out)
		r.finish(cmd.Wait())
		cancel()
	}()
	return r, nil
}

func (st signInState) isOver() bool { return st.State == "done" || st.State == "failed" }

// paste hands Claude the code from its sign-in page.
func (r *signInRun) paste(code string) error {
	r.mu.Lock()
	if r.done {
		r.mu.Unlock()
		return errors.New("the sign-in is over")
	}
	r.pasted = true
	r.mu.Unlock()
	_, err := io.WriteString(r.stdin, strings.TrimSpace(code)+"\n")
	return err
}

func (r *signInRun) stop() {
	r.cancel()
	r.stdin.Close()
}

// stopAll ends every run, at shutdown.
func (s *signIns) stopAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.runs {
		r.stop()
	}
}

// POST /api/signin {cli}: starts the CLI's sign-in (or finds the one
// going) and answers with its state once the link is in, or after
// signInWait with whatever there is.
func (s *Server) signInStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CLI string `json:"cli"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	var bin string
	switch req.CLI {
	case "claude":
		bin = s.runner.clis.Claude()
	case "codex":
		bin = s.runner.clis.Codex()
	}
	run, err := s.signins.start(req.CLI, bin)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	deadline := time.Now().Add(signInWait)
	for {
		st := run.state()
		if st.State != "starting" || time.Now().After(deadline) {
			if st.State == "starting" {
				// No link after the wait: say what the CLI printed instead.
				run.stop()
				run.mu.Lock()
				st.State, st.Error = "failed", strings.TrimSpace(run.out.String())
				run.mu.Unlock()
				if st.Error == "" {
					st.Error = "the CLI printed no sign-in link"
				}
			}
			writeJSON(w, st)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// GET /api/signin?cli=: the state, for the page's polling while it waits.
func (s *Server) signInStatus(w http.ResponseWriter, r *http.Request) {
	cli := r.URL.Query().Get("cli")
	run := s.signins.get(cli)
	if run == nil {
		writeJSON(w, signInState{CLI: cli, State: "failed", Error: "no sign-in going"})
		return
	}
	writeJSON(w, run.state())
}

// POST /api/signin/code {cli, code}: Claude's pasted code.
func (s *Server) signInCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CLI  string `json:"cli"`
		Code string `json:"code"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	run := s.signins.get(req.CLI)
	if run == nil {
		http.Error(w, "no sign-in going", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Code) == "" {
		http.Error(w, "paste the code first", http.StatusBadRequest)
		return
	}
	if err := run.paste(req.Code); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// The CLI answers within a few seconds either way; let the page see
	// the outcome in this reply when it is quick.
	deadline := time.Now().Add(10 * time.Second)
	for !run.state().isOver() && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
	}
	writeJSON(w, run.state())
}

// POST /api/signin/cancel {cli}: ends the run.
func (s *Server) signInCancel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CLI string `json:"cli"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if run := s.signins.get(req.CLI); run != nil {
		run.stop()
	}
	writeJSON(w, map[string]bool{"ok": true})
}
