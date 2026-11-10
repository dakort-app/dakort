package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A folder's tabs are null until a device sets them, then what was set, and
// every device hears the change on the stream. Bad lists are refused.
func TestTabs(t *testing.T) {
	f := setup(t)
	get := func(folder string) (json.RawMessage, int) {
		resp, body := fetch(t, f.srv.URL+"/api/tabs?folder="+url.QueryEscape(folder), token)
		var r struct{ IDs json.RawMessage }
		json.Unmarshal(body, &r)
		return r.IDs, resp.StatusCode
	}
	if ids, code := get(`C:\w`); code != 200 || string(ids) != "null" {
		t.Fatalf("unknown folder: %d %s, want null", code, ids)
	}

	// Listen before setting.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", f.srv.URL+"/api/events", nil)
	req.AddCookie(&http.Cookie{Name: "dakort_token", Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if code, out := post(t, f.srv.URL+"/api/tabs", map[string]any{"folder": `C:\w`, "ids": []string{"s1", "f:notes.md", "new"}}); code != 200 {
		t.Fatalf("set: %d %s", code, out)
	}
	if ids, _ := get(`C:\w`); string(ids) != `["s1","f:notes.md","new"]` {
		t.Errorf("after set: %s", ids)
	}
	// Both spellings of a folder are one where the disk ignores case
	// (Windows, a Mac's default disk); on Linux they are two folders.
	if ids, _ := get(`c:\W`); (runtime.GOOS == "linux") == (string(ids) == `["s1","f:notes.md","new"]`) {
		t.Errorf("other spelling on %s: %s", runtime.GOOS, ids)
	}
	sc := bufio.NewScanner(resp.Body)
	heard := false
	for sc.Scan() {
		if line := sc.Text(); strings.Contains(line, `"type":"tabs"`) {
			if !strings.Contains(line, `"folder":"C:\\w"`) || !strings.Contains(line, `"tabs":["s1","f:notes.md","new"]`) {
				t.Errorf("tabs event: %s", line)
			}
			heard = true
			break
		}
	}
	if !heard {
		t.Error("no tabs event within 5 s")
	}

	// Empty is a list too, not unknown.
	if code, _ := post(t, f.srv.URL+"/api/tabs", map[string]any{"folder": `C:\w`, "ids": []string{}}); code != 200 {
		t.Fatalf("set empty: %d", code)
	}
	if ids, _ := get(`C:\w`); string(ids) != `[]` {
		t.Errorf("after emptying: %s", ids)
	}

	for _, bad := range []map[string]any{
		{"ids": []string{"s1"}},
		{"folder": `C:\w`, "ids": []string{""}},
		{"folder": `C:\w`, "ids": []string{strings.Repeat("x", 1001)}},
		{"folder": `C:\w`, "ids": make([]string, 201)},
	} {
		if code, _ := post(t, f.srv.URL+"/api/tabs", bad); code != 400 {
			t.Errorf("%v: %d, want 400", bad, code)
		}
	}
	if _, code := get(""); code != 400 {
		t.Errorf("get without a folder: %d", code)
	}
}
