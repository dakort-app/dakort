package server_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/server"
	"github.com/dakort-app/dakort/internal/transcript"
)

const token = "0123456789abcdef0123456789abcdef0123456789abcdef"

const pngDot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="

func row(i int) string {
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":"prompt %d"},"uuid":"u%d","timestamp":"2026-10-01T10:00:%02dZ","cwd":"C:\\w","sessionId":"s1"}`, i, i, i)
}

const imageRow = `{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + pngDot + `"}},{"type":"text","text":"what is this"}]},"uuid":"img","timestamp":"2026-10-01T10:01:00Z","sessionId":"s1"}`

type fixture struct {
	srv      *httptest.Server
	path     string // the session file
	registry string // the fake ~/.claude/sessions
}

func setup(t *testing.T) fixture {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "projects", "C--w", "s1.jsonl")
	os.MkdirAll(filepath.Dir(path), 0o755)
	var lines []string
	for i := 1; i <= 5; i++ {
		lines = append(lines, row(i))
	}
	lines = append(lines, imageRow, `{"type":"cost-state","sessionId":"s1"}`)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := server.New(server.Config{
		Token:  token,
		Index:  &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")},
		Assets: transcript.Dir(filepath.Join(root, "assets")),
	})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close) // runs first, ending open event streams
	return fixture{srv, path, filepath.Join(root, "sessions")}
}

// fetch makes a request, logged in unless the cookie is empty.
func fetch(t *testing.T, url, cookie string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "made_token", Value: cookie})
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

type page struct {
	Rows    []transcript.Row `json:"rows"`
	AtStart bool             `json:"atStart"`
	Next    int64            `json:"next"`
}

func getPage(t *testing.T, url string) page {
	t.Helper()
	resp, body := fetch(t, url, token)
	if resp.StatusCode != 200 {
		t.Fatalf("%s: %d %s", url, resp.StatusCode, body)
	}
	var p page
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func ids(rows []transcript.Row) string {
	var s []string
	for _, r := range rows {
		s = append(s, r.UUID)
	}
	return strings.Join(s, ",")
}

func TestAuth(t *testing.T) {
	f := setup(t)
	for _, c := range []struct {
		url, cookie string
		want        int
	}{
		{"/api/sessions", "", 401},
		{"/api/sessions", "wrong", 401},
		{"/", "", 401},
		{"/login?token=wrong", "", 401},
		{"/login", "", 200}, // the password page
		{"/api/sessions", token, 200},
		{"/", token, 200},
	} {
		if resp, body := fetch(t, f.srv.URL+c.url, c.cookie); resp.StatusCode != c.want {
			t.Errorf("%s with cookie %q: %d, want %d (%s)", c.url, c.cookie, resp.StatusCode, c.want, body)
		}
	}
	resp, _ := fetch(t, f.srv.URL+"/login?token="+token, "")
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/" {
		t.Fatalf("login: %d to %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	cs := resp.Cookies()
	if len(cs) != 1 || cs[0].Value != token || !cs[0].HttpOnly || cs[0].SameSite != http.SameSiteStrictMode {
		t.Errorf("login cookie: %+v", cs)
	}
}

// The embedded UI is the committed build of web/: the page and the files
// it names are all served.
func TestEmbeddedUI(t *testing.T) {
	f := setup(t)
	resp, body := fetch(t, f.srv.URL+"/", token)
	if resp.StatusCode != 200 {
		t.Fatalf("/: %d", resp.StatusCode)
	}
	// Every script and stylesheet the page names is served.
	refs := regexp.MustCompile(`(?:src|href)="(/[^"]+)"`).FindAllStringSubmatch(string(body), -1)
	if len(refs) < 2 {
		t.Fatalf("index.html names %d files; rebuild with npm run build in web/", len(refs))
	}
	for _, m := range refs {
		if resp, _ := fetch(t, f.srv.URL+m[1], token); resp.StatusCode != 200 {
			t.Errorf("%s: %d", m[1], resp.StatusCode)
		}
	}
	// Scripts are JavaScript whatever the Windows registry says, and big
	// ones go compressed (the Go client asks for gzip and unpacks it).
	for name, ctype := range map[string]string{"/app.js": "text/javascript; charset=utf-8", "/pdf.worker.min.mjs": "text/javascript; charset=utf-8"} {
		resp, body := fetch(t, f.srv.URL+name, token)
		if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != ctype || !resp.Uncompressed || len(body) < 10000 {
			t.Errorf("%s: %d %q gzip=%v %d bytes", name, resp.StatusCode, resp.Header.Get("Content-Type"), resp.Uncompressed, len(body))
		}
	}
	// A reload revalidates instead of refetching.
	for _, name := range []string{"/", "/app.js"} {
		resp, _ := fetch(t, f.srv.URL+name, token)
		tag := resp.Header.Get("ETag")
		req, _ := http.NewRequest("GET", f.srv.URL+name, nil)
		req.AddCookie(&http.Cookie{Name: "made_token", Value: token})
		req.Header.Set("If-None-Match", tag)
		r2, err := http.DefaultClient.Do(req)
		if tag == "" || err != nil || r2.StatusCode != 304 {
			t.Errorf("%s: etag %q, revalidation %v %v", name, tag, err, r2)
		}
	}
}

func TestSessionsAndRows(t *testing.T) {
	f := setup(t)
	resp, body := fetch(t, f.srv.URL+"/api/sessions", token)
	var list []index.Session
	if resp.StatusCode != 200 || json.Unmarshal(body, &list) != nil || len(list) != 1 || list[0].ID != "s1" {
		t.Fatalf("sessions: %d %s", resp.StatusCode, body)
	}
	if strings.Contains(string(body), "jsonl") {
		t.Errorf("the list leaks file paths: %s", body)
	}

	base := f.srv.URL + "/api/sessions/s1/rows"
	newest := getPage(t, base+"?n=2")
	if ids(newest.Rows) != "u5,img" || newest.AtStart {
		t.Fatalf("newest page: %s atStart=%v", ids(newest.Rows), newest.AtStart)
	}
	older := getPage(t, fmt.Sprintf("%s?n=10&before=%d", base, newest.Rows[0].Offset))
	if ids(older.Rows) != "u1,u2,u3,u4" || !older.AtStart {
		t.Errorf("older page: %s atStart=%v", ids(older.Rows), older.AtStart)
	}

	// The image went to the asset store and is served from there.
	b := newest.Rows[1].Blocks[0]
	if b.Type != "image" || b.Asset == "" {
		t.Fatalf("image block: %+v", b)
	}
	resp, body = fetch(t, f.srv.URL+"/api/assets/"+b.Asset, token)
	want, _ := base64.StdEncoding.DecodeString(pngDot)
	if resp.StatusCode != 200 || string(body) != string(want) || resp.Header.Get("Content-Type") != "image/png" {
		t.Errorf("asset: %d %q, %d bytes", resp.StatusCode, resp.Header.Get("Content-Type"), len(body))
	}

	// Catch up after an append, from the cursor the first page gave.
	fh, _ := os.OpenFile(f.path, os.O_APPEND|os.O_WRONLY, 0)
	fh.WriteString(row(6) + "\n" + `{"type":"user","uuid":"partial"`)
	fh.Close()
	caught := getPage(t, fmt.Sprintf("%s?after=%d", base, newest.Next))
	if ids(caught.Rows) != "u6" {
		t.Errorf("catch-up: %s", ids(caught.Rows))
	}
	if again := getPage(t, fmt.Sprintf("%s?after=%d", base, caught.Next)); len(again.Rows) != 0 {
		t.Errorf("second catch-up should be empty until the partial line ends: %s", ids(again.Rows))
	}

	for url, code := range map[string]int{
		base + "?before=7":                     400, // not a line start
		base + "?after=7":                      400,
		base + "?n=0":                          400,
		base + "?before=x":                     400,
		f.srv.URL + "/api/sessions/nope/rows":  404,
		f.srv.URL + "/api/assets/..%2Ftoken":   404,
		f.srv.URL + "/api/assets/" + "abc.png": 404,
	} {
		if resp, body := fetch(t, url, token); resp.StatusCode != code {
			t.Errorf("%s: %d, want %d (%s)", url, resp.StatusCode, code, body)
		}
	}
}

// The 48 MB stress session through the API, read only: the newest page
// and a page further up stay small, since images are served separately.
func TestBigSession(t *testing.T) {
	const id = "528d9def-5290-4c75-9f2f-bee41c4a04a0"
	x := index.New()
	if _, err := x.Refresh(); err != nil {
		t.Fatal(err)
	}
	if _, ok := x.Get(id); !ok {
		t.Skip("stress fixture not present")
	}
	s := server.New(server.Config{Token: token, Index: x, Assets: transcript.Dir(t.TempDir())})
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	defer s.Close()

	start := time.Now()
	resp, body := fetch(t, srv.URL+"/api/sessions/"+id+"/rows", token)
	took := time.Since(start)
	var p page
	if resp.StatusCode != 200 || json.Unmarshal(body, &p) != nil || len(p.Rows) != 50 {
		t.Fatalf("newest page: %d, %d rows", resp.StatusCode, len(p.Rows))
	}
	t.Logf("newest 50 rows: %d KB in %v", len(body)>>10, took)
	start = time.Now()
	resp, body = fetch(t, fmt.Sprintf("%s/api/sessions/%s/rows?n=200&before=%d", srv.URL, id, p.Rows[0].Offset), token)
	t.Logf("200 older rows: %d KB in %v", len(body)>>10, time.Since(start))
	if resp.StatusCode != 200 || len(body) > 2<<20 {
		t.Errorf("older page: %d, %d KB", resp.StatusCode, len(body)>>10)
	}
}
