package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dakort-app/dakort/internal/transcript"
)

// Deleting a session moves its transcript (and the folder of the same name
// next to it, where the CLI keeps subagent and tool output) into the app's
// trash, so a mis-tap on a phone is undone with one more tap. The trash is
// emptied of entries older than trashKeep.
//
//	POST /api/sessions/{id}/delete   {}: into the trash; answers {trash}
//	POST /api/trash/{name}/restore   {}: back where it was
//	GET  /api/config                 what the picker needs: the CLI's default model and effort

const trashKeep = 30 * 24 * time.Hour

var (
	sessionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// Every trash entry is named like this; nothing else in the trash
	// folder is ever moved or removed.
	trashName = regexp.MustCompile(`^made-trash-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type trashMeta struct {
	ID      string    `json:"id"`
	Path    string    `json:"path"` // the transcript's original path
	Title   string    `json:"title"`
	Deleted time.Time `json:"deleted"`
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	if !readJSON(w, r, &struct{}{}) {
		return
	}
	id := r.PathValue("id")
	if !sessionID.MatchString(id) || s.trash == "" {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "bad session id"})
		return
	}
	sess, ok := s.idx.Get(id)
	if !ok {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 404, msg: "no such session"})
		return
	}
	if s.runner.busy(id) {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 409, msg: "a turn or a background task is running in this session; stop it first"})
		return
	}
	if sess.HeldBy != 0 && !s.runner.isOurs(sess.HeldBy) {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 409, heldBy: sess.HeldBy, msg: "the session is open in another Claude process; close it there first"})
		return
	}
	name := "made-trash-" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "-" + id
	dir := filepath.Join(s.trash, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	meta, _ := json.Marshal(trashMeta{ID: id, Path: sess.Path, Title: sess.Title, Deleted: time.Now()})
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o600); err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	// A rename, never copy-and-delete: on the same drive it is atomic, and
	// if it fails nothing has been lost.
	if err := os.Rename(sess.Path, filepath.Join(dir, filepath.Base(sess.Path))); err != nil {
		os.Remove(filepath.Join(dir, "meta.json"))
		os.Remove(dir)
		s.reply(w, http.StatusOK)(nil, &httpError{status: 500, msg: "could not move the transcript: " + err.Error()})
		return
	}
	side := strings.TrimSuffix(sess.Path, filepath.Ext(sess.Path))
	if fi, err := os.Stat(side); err == nil && fi.IsDir() {
		if err := os.Rename(side, filepath.Join(dir, "files")); err != nil {
			log.Printf("trash %s: the folder next to the transcript stayed: %v", id, err)
		}
	}
	s.refresh(true)
	writeJSON(w, struct {
		Trash string `json:"trash"`
	}{name})
}

func (s *Server) restoreSession(w http.ResponseWriter, r *http.Request) {
	if !readJSON(w, r, &struct{}{}) {
		return
	}
	name := r.PathValue("name")
	if !trashName.MatchString(name) || s.trash == "" {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "bad trash entry"})
		return
	}
	dir := filepath.Join(s.trash, name)
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	var meta trashMeta
	if err != nil || json.Unmarshal(data, &meta) != nil || !sessionID.MatchString(meta.ID) {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 404, msg: "no such trash entry"})
		return
	}
	// The file is the session's own: <id>.jsonl, or a Codex rollout named
	// after the thread.
	if rollout, _ := transcript.IsRollout(filepath.Base(meta.Path)); filepath.Base(meta.Path) != meta.ID+".jsonl" && rollout != meta.ID {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 404, msg: "no such trash entry"})
		return
	}
	if _, err := os.Stat(meta.Path); err == nil {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 409, msg: "a session with that id exists again"})
		return
	}
	os.MkdirAll(filepath.Dir(meta.Path), 0o700)
	if err := os.Rename(filepath.Join(dir, filepath.Base(meta.Path)), meta.Path); err != nil {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 500, msg: "could not restore: " + err.Error()})
		return
	}
	side := strings.TrimSuffix(meta.Path, filepath.Ext(meta.Path))
	if fi, err := os.Stat(filepath.Join(dir, "files")); err == nil && fi.IsDir() {
		os.Rename(filepath.Join(dir, "files"), side)
	}
	os.Remove(filepath.Join(dir, "meta.json"))
	os.Remove(dir) // empty by now; Remove refuses otherwise
	s.refresh(true)
	writeJSON(w, struct {
		ID string `json:"id"`
	}{meta.ID})
}

// emptyTrash removes entries older than trashKeep. Only names matching
// trashName, directly inside the trash folder, are ever removed.
func emptyTrash(trash string) {
	if trash == "" {
		return
	}
	ents, err := os.ReadDir(trash)
	if err != nil {
		return
	}
	for _, e := range ents {
		name := e.Name()
		if !e.IsDir() || !trashName.MatchString(name) {
			continue
		}
		ms, err := strconv.ParseInt(strings.SplitN(strings.TrimPrefix(name, "made-trash-"), "-", 2)[0], 10, 64)
		if err != nil || time.Since(time.UnixMilli(ms)) < trashKeep {
			continue
		}
		dir := filepath.Join(trash, name)
		if filepath.Dir(dir) != filepath.Clean(trash) || !strings.HasPrefix(filepath.Base(dir), "made-trash-") {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("emptying trash: %v", err)
		}
	}
}

// config tells the composer what "default" means here: the model, effort,
// permission mode and prompt-cache lifetime the user's Claude settings
// name, if any, and which CLIs are installed (with how to get a missing one).
func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	st := readClaudeSettings()
	writeJSON(w, struct {
		DefaultModel  string      `json:"defaultModel,omitempty"`
		DefaultEffort string      `json:"defaultEffort,omitempty"`
		DefaultMode   string      `json:"defaultMode,omitempty"`
		CacheTTL      string      `json:"cacheTtl,omitempty"` // "5m" or "1h"; automatic when empty
		Claude        *claudeInfo `json:"claude,omitempty"`   // the CLI's model list; absent until the CLI answers
		Codex         *codexInfo  `json:"codex,omitempty"`    // absent when Codex is not installed
		CLIs          []cliStatus `json:"clis"`
		AutoUpdate    bool        `json:"autoUpdate"` // this server installs newer releases by itself (release.go)
	}{st.Model, st.EffortLevel, st.Permissions.DefaultMode, st.PromptCacheTTL, s.claudeInfo(r.Context()), s.codexInfo(r.Context()), s.runner.clis.status(), s.autoUpdate})
}

// claudeSettings is the part of ~/.claude/settings.json the server reads.
type claudeSettings struct {
	Model          string `json:"model"`
	EffortLevel    string `json:"effortLevel"`
	PromptCacheTTL string `json:"promptCacheTtl"`
	Permissions    struct {
		DefaultMode string `json:"defaultMode"`
	} `json:"permissions"`
}

func readClaudeSettings() claudeSettings {
	var st claudeSettings
	home, err := os.UserHomeDir()
	if err != nil {
		return st
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("reading Claude settings: %v", err)
		}
		return st
	}
	json.Unmarshal(data, &st)
	return st
}
