package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/claude"
)

// The composer's "/" menu: the slash commands that make sense here.
//
//	GET /api/commands?folder=F   [{name, description, argumentHint, builtin}]
//
// The list comes from the CLI's initialize answer in that folder (project
// commands depend on it), cached a while per folder. Skills and custom
// commands all stay: they expand into a prompt. Of the built-ins only those
// measured to work headless stay (BRIEF): the rest drive the terminal's own
// screens (/config, /mcp), set something for one process (/model, which a
// per-turn process forgets), or are covered by the app (/clear: the new
// session button; model and mode: the chips).
var headlessBuiltins = []string{"compact", "context", "usage", "goal", "recap", "rename", "init"}

const commandsFresh = 10 * time.Minute

type command struct {
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	ArgumentHint string `json:"argumentHint,omitempty"`
	Builtin      bool   `json:"builtin,omitempty"`
}

type commandList struct {
	at   time.Time
	list []command
}

type commandCache struct {
	mu sync.Mutex
	m  map[string]commandList // by folderKey
}

func (s *Server) commands(w http.ResponseWriter, r *http.Request) {
	folder := r.URL.Query().Get("folder")
	if fi, err := os.Stat(folder); !filepath.IsAbs(folder) || err != nil || !fi.IsDir() {
		http.Error(w, "folder must be an absolute path to a folder", http.StatusBadRequest)
		return
	}
	k := folderKey(folder)
	s.cmds.mu.Lock()
	c, ok := s.cmds.m[k]
	s.cmds.mu.Unlock()
	if !ok || time.Since(c.at) > commandsFresh {
		list, err := s.fetchCommands(r.Context(), folder)
		if err != nil {
			http.Error(w, "asking the CLI for its commands: "+err.Error(), http.StatusBadGateway)
			return
		}
		c = commandList{at: time.Now(), list: list}
		s.cmds.mu.Lock()
		if s.cmds.m == nil {
			s.cmds.m = map[string]commandList{}
		}
		s.cmds.m[k] = c
		s.cmds.mu.Unlock()
	}
	writeJSON(w, c.list)
}

func (s *Server) fetchCommands(ctx context.Context, folder string) ([]command, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	p, err := claude.Start(ctx, claude.Options{Bin: s.runner.clis.Claude(), Cwd: folder})
	if err != nil {
		return nil, err
	}
	defer p.Close()
	raw, err := p.Initialize(ctx)
	if err != nil {
		return nil, err
	}
	var init struct {
		Commands []command `json:"commands"`
	}
	if err := json.Unmarshal(raw, &init); err != nil {
		return nil, err
	}
	s.setClaudeModels(raw) // the same answer lists the models
	return pickCommands(init.Commands), nil
}

// pickCommands keeps the headless built-ins, in their order of use, then
// every skill and custom command as the CLI lists them.
func pickCommands(all []command) []command {
	var out []command
	for _, name := range headlessBuiltins {
		for _, c := range all {
			if c.Builtin && c.Name == name {
				out = append(out, c)
			}
		}
	}
	for _, c := range all {
		if !c.Builtin && !strings.HasPrefix(c.Name, "__") {
			out = append(out, c)
		}
	}
	return out
}
