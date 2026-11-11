package server

import (
	"runtime"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/claude"
	"github.com/dakort-app/dakort/internal/codex"
)

// The app never installs Claude or Codex for the person: it says what is
// missing and how to get it (GET /api/config, clis), and a CLI installed
// while the app runs is found on the next ask, so following the hint
// needs no restart.

// lookAgain is how often a missing CLI is looked for again.
const lookAgain = 10 * time.Second

type cliPaths struct {
	mu                    sync.Mutex
	claude, codex         string
	claudeLook, codexLook time.Time
	findClaude, findCodex func() (string, error) // the packages' FindBinary
}

func newCLIPaths(claudeBin, codexBin string) *cliPaths {
	return &cliPaths{claude: claudeBin, codex: codexBin, claudeLook: time.Now(), codexLook: time.Now(),
		findClaude: claude.FindBinary, findCodex: codex.FindBinary}
}

func look(path *string, at *time.Time, find func() (string, error)) string {
	if *path == "" && find != nil && time.Since(*at) >= lookAgain {
		*at = time.Now()
		*path, _ = find()
	}
	return *path
}

// Claude is claude's program, empty when not installed.
func (c *cliPaths) Claude() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return look(&c.claude, &c.claudeLook, c.findClaude)
}

// Codex is codex's program, empty when not installed.
func (c *cliPaths) Codex() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return look(&c.codex, &c.codexLook, c.findCodex)
}

// cliStatus is one CLI as the UI shows it: whether it is here, and, if
// not, the command that installs it on this OS. Signing in is the CLI's
// own first run, in a terminal, or from the page (signin.go) once it is
// installed.
type cliStatus struct {
	Name    string `json:"name"` // claude or codex
	Found   bool   `json:"found"`
	Install string `json:"install,omitempty"` // a terminal command, when not found
	Shell   string `json:"shell"`             // where to type it: PowerShell on Windows
	SignIn  string `json:"signIn"`            // the command whose first run signs in
}

// shellName is where an install command is typed: Claude's Windows one
// is PowerShell's.
func shellName() string {
	if runtime.GOOS == "windows" {
		return "PowerShell"
	}
	return "a terminal"
}

func (c *cliPaths) status() []cliStatus {
	shell := shellName()
	cl, cx := c.Claude(), c.Codex()
	return []cliStatus{
		{Name: "claude", Found: cl != "", Install: installHint("claude", cl), Shell: shell, SignIn: "claude"},
		{Name: "codex", Found: cx != "", Install: installHint("codex", cx), Shell: shell, SignIn: "codex"},
	}
}

// installHint is the official install command (Anthropic's native
// installer; OpenAI's npm package, which needs Node), empty when found.
func installHint(name, path string) string {
	switch {
	case path != "":
		return ""
	case name == "codex" && runtime.GOOS == "windows":
		return `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`
	case name == "codex":
		return "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
	case runtime.GOOS == "windows":
		return "irm https://claude.ai/install.ps1 | iex"
	default:
		return "curl -fsSL https://claude.ai/install.sh | bash"
	}
}
