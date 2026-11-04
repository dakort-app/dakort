package server_test

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

// Deleting moves a session and its side folder into the trash, the index
// forgets it, and restoring puts both back.
func TestDeleteAndRestore(t *testing.T) {
	root := t.TempDir()
	const id = "11111111-2222-4333-8444-555555555555"
	proj := filepath.Join(root, "projects", "C--w")
	path := filepath.Join(proj, id+".jsonl")
	writeSession(t, path, row(1))
	os.MkdirAll(filepath.Join(proj, id, "subagents"), 0o755)
	os.WriteFile(filepath.Join(proj, id, "subagents", "a.jsonl"), []byte("{}\n"), 0o644)
	trash := filepath.Join(root, "trash")
	s := server.New(server.Config{Token: token, Trash: trash, Assets: transcript.Dir(filepath.Join(root, "assets")),
		Index: &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")}})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)
	u := srv.URL

	listed := func() bool {
		var list []struct{ ID string }
		_, body := fetch(t, u+"/api/sessions", token)
		json.Unmarshal(body, &list)
		for _, x := range list {
			if x.ID == id {
				return true
			}
		}
		return false
	}
	if !listed() {
		t.Fatal("the session is not listed to begin with")
	}

	code, body := post(t, u+"/api/sessions/"+id+"/delete", map[string]any{})
	var del struct{ Trash string }
	if code != 200 || json.Unmarshal(body, &del) != nil || del.Trash == "" {
		t.Fatalf("delete: %d %s", code, body)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("the transcript is still in place: %v", err)
	}
	if _, err := os.Stat(filepath.Join(trash, del.Trash, "files", "subagents", "a.jsonl")); err != nil {
		t.Errorf("the side folder did not go to the trash: %v", err)
	}
	if listed() {
		t.Error("still listed after delete")
	}

	if code, body := post(t, u+"/api/trash/"+del.Trash+"/restore", map[string]any{}); code != 200 {
		t.Fatalf("restore: %d %s", code, body)
	}
	if _, err := os.Stat(filepath.Join(proj, id, "subagents", "a.jsonl")); err != nil {
		t.Errorf("side folder not restored: %v", err)
	}
	if !listed() {
		t.Error("not listed after restore")
	}
	if _, err := os.Stat(filepath.Join(trash, del.Trash)); !os.IsNotExist(err) {
		t.Errorf("the trash entry is still there: %v", err)
	}

	for url, want := range map[string]int{
		u + "/api/sessions/not-a-uuid/delete":                           400,
		u + "/api/sessions/99999999-2222-4333-8444-555555555555/delete": 404,
		u + "/api/trash/../../x/restore":                                405, // cleaned to /x/restore, which takes no POST
		u + "/api/trash/made-trash-1-" + id + "/restore":                404,
		u + "/api/trash/evil/restore":                                   400,
	} {
		if code, body := post(t, url, map[string]any{}); code != want {
			t.Errorf("%s: %d %s, want %d", url, code, body, want)
		}
	}
}
