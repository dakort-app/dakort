package server_test

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

// The Changes panel lists what is not on the remote yet: a file changed
// and committed but not pushed, as much as one only changed, and its
// diff against the upstream carries both.
func TestGitLocalAgainstUpstream(t *testing.T) {
	f := newGitFixture(t)
	write(t, f.root, "b.txt", "bee\ncommitted\n")
	gitOut(t, f.root, "commit", "-q", "-am", "local")
	write(t, f.root, "b.txt", "bee\ncommitted\nnot yet\n")
	write(t, f.root, "x.txt", "shared, edited\n")

	resp, body := fetch(t, f.base+"/api/git?root="+url.QueryEscape(f.root), token)
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d %s", resp.StatusCode, body)
	}
	var st struct {
		Repos []struct {
			Ahead int
			Local []struct {
				Path, St string
				WA, WD   int
			}
		}
	}
	json.Unmarshal(body, &st)
	if len(st.Repos) != 1 || st.Repos[0].Ahead != 1 {
		t.Fatalf("repos: %+v", st.Repos)
	}
	got := map[string]string{}
	for _, l := range st.Repos[0].Local {
		got[l.Path] = l.St
		if l.Path == "b.txt" && (l.WA != 2 || l.WD != 0) {
			t.Errorf("b.txt lines against the upstream: +%d -%d", l.WA, l.WD)
		}
	}
	if len(got) != 2 || got["b.txt"] != "M" || got["x.txt"] != "M" {
		t.Errorf("local: %v", got)
	}

	_, body = fetch(t, f.base+"/api/git/diff?base=upstream&root="+url.QueryEscape(f.root)+"&path=b.txt", token)
	var d struct{ Diff string }
	json.Unmarshal(body, &d)
	if !strings.Contains(d.Diff, "+committed") || !strings.Contains(d.Diff, "+not yet") {
		t.Errorf("diff against the upstream: %s", d.Diff)
	}
	// Without base, still the change since the last commit.
	_, body = fetch(t, f.base+"/api/git/diff?root="+url.QueryEscape(f.root)+"&path=b.txt", token)
	json.Unmarshal(body, &d)
	if strings.Contains(d.Diff, "+committed") || !strings.Contains(d.Diff, "+not yet") {
		t.Errorf("diff since HEAD: %s", d.Diff)
	}
}
