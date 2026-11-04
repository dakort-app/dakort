package server

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/codex"
)

// What the model picker needs to know about Codex: the models the account
// offers, from the app-server (asked once an hour; under a second, no
// thread opened), and the defaults in ~/.codex/config.toml.
type codexInfo struct {
	Models        []codex.Model `json:"models"`
	DefaultModel  string        `json:"defaultModel,omitempty"`
	DefaultEffort string        `json:"defaultEffort,omitempty"`
}

const codexModelsFresh = time.Hour

type codexCache struct {
	mu     sync.Mutex
	at     time.Time
	models []codex.Model
}

func (s *Server) codexInfo(ctx context.Context) *codexInfo {
	if s.runner.clis.Codex() == "" {
		return nil
	}
	s.codex.mu.Lock()
	defer s.codex.mu.Unlock()
	if s.codex.models == nil || time.Since(s.codex.at) > codexModelsFresh {
		ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		list, err := codex.Models(ctx, s.runner.clis.Codex())
		if err != nil {
			log.Printf("asking codex for its models: %v", err)
			if s.codex.models == nil {
				return nil
			}
		} else {
			s.codex.models, s.codex.at = list, time.Now()
		}
	}
	info := &codexInfo{Models: s.codex.models}
	info.DefaultModel, info.DefaultEffort = codexDefaults()
	return info
}

// codexDefaults reads the two top-level keys of ~/.codex/config.toml the
// picker shows; a full TOML reader is more than this needs.
func codexDefaults() (model, effort string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		return "", ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "[") {
			break // the top-level keys come first
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		switch strings.TrimSpace(k) {
		case "model":
			model = v
		case "model_reasoning_effort":
			effort = v
		}
	}
	return
}
