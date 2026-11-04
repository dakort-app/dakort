package server

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/claude"
)

// The Claude models the picker offers, from the CLI's own initialize
// answer (no user line, so no API call, no transcript; BRIEF). The answer
// lists the aliases first (opus, fable, sonnet, haiku), then older models
// by full id; the picker shows the aliases, and "default" says which
// model the account's default resolves to. Refreshed once an hour, and
// whenever the "/" menu asks the CLI (commands.go), since that is the
// same answer.
type claudeModel struct {
	ID      string   `json:"id"`   // the alias the CLI takes: opus, fable, ...
	Full    string   `json:"full"` // the model behind it now: claude-opus-5-5
	Label   string   `json:"label"`
	Desc    string   `json:"desc,omitempty"`
	Efforts []string `json:"efforts,omitempty"`
}

type claudeInfo struct {
	Models       []claudeModel `json:"models"`
	DefaultModel string        `json:"defaultModel,omitempty"` // the full id "default" resolves to
}

const claudeModelsFresh = time.Hour

type claudeCache struct {
	mu   sync.Mutex
	at   time.Time
	info *claudeInfo
}

// setClaudeModels keeps an initialize answer's models (called by
// fetchCommands too).
func (s *Server) setClaudeModels(raw json.RawMessage) {
	info := parseClaudeModels(raw)
	if info == nil {
		return
	}
	s.claude.mu.Lock()
	s.claude.info, s.claude.at = info, time.Now()
	s.claude.mu.Unlock()
}

func parseClaudeModels(raw json.RawMessage) *claudeInfo {
	var init struct {
		Models []struct {
			Value       string   `json:"value"`
			Resolved    string   `json:"resolvedModel"`
			DisplayName string   `json:"displayName"`
			Description string   `json:"description"`
			Efforts     []string `json:"supportedEffortLevels"`
		} `json:"models"`
	}
	if json.Unmarshal(raw, &init) != nil || len(init.Models) == 0 {
		return nil
	}
	info := &claudeInfo{}
	for _, m := range init.Models {
		switch {
		case m.Value == "default":
			info.DefaultModel = m.Resolved
		case strings.HasPrefix(m.Value, "claude-"):
			// An older model by full id: the picker keeps to the aliases.
		default:
			info.Models = append(info.Models, claudeModel{ID: m.Value, Full: m.Resolved, Label: m.DisplayName, Desc: m.Description, Efforts: m.Efforts})
		}
	}
	return info
}

func (s *Server) claudeInfo(ctx context.Context) *claudeInfo {
	if s.runner.clis.Claude() == "" {
		return nil
	}
	s.claude.mu.Lock()
	defer s.claude.mu.Unlock()
	if s.claude.info != nil && time.Since(s.claude.at) < claudeModelsFresh {
		return s.claude.info
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return s.claude.info
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	p, err := claude.Start(ctx, claude.Options{Bin: s.runner.clis.Claude(), Cwd: home})
	if err != nil {
		log.Printf("asking claude for its models: %v", err)
		return s.claude.info
	}
	defer p.Close()
	raw, err := p.Initialize(ctx)
	if err != nil {
		log.Printf("asking claude for its models: %v", err)
		return s.claude.info
	}
	if info := parseClaudeModels(raw); info != nil {
		s.claude.info, s.claude.at = info, time.Now()
	}
	return s.claude.info
}
