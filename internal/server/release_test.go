package server

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/index"
)

func TestNewerRelease(t *testing.T) {
	cases := []struct {
		build, tag string
		want       bool
	}{
		{"v0.1.0", "v0.2.0", true},
		{"v0.1.0", "v0.1.1", true},
		{"v0.1.0", "v1.0.0", true},
		{"v0.2.0", "v0.1.9", false},
		{"v0.1.0", "v0.1.0", false},
		{"v0.1.0-rc1", "v0.1.0", true},
		{"v0.1.0-rc1", "v0.1.0-rc2", true},
		{"v0.1.0-rc9", "v0.1.0-rc10", true},
		{"v0.1.0-rc2", "v0.1.0-rc1", false},
		{"v0.1.0", "v0.1.0-rc1", false},
		{"v0.1.0-3-g1a2b3c4", "v0.1.0", false},
		{"v0.1.0-3-g1a2b3c4-dirty", "v0.1.0", false},
		{"v0.1.0-3-g1a2b3c4", "v0.1.1", true},
		{"v0.1.0-rc1-3-g1a2b3c4", "v0.1.0", true},
		{"dev", "v0.1.0", false},
		{"test1", "v0.1.0", false},
		{"v0.1.0", "nightly", false},
	}
	for _, c := range cases {
		if got := NewerRelease(c.build, c.tag); got != c.want {
			t.Errorf("NewerRelease(%q, %q) = %v, want %v", c.build, c.tag, got, c.want)
		}
	}
}

// With Auto on, a release build installs a newer release by itself once
// it has been out for MinAge, through Update, and the snapshot names the
// tag being installed; a build past a tag (a deploy of the dev tree) and
// a release younger than MinAge are left alone.
func TestAutoUpdate(t *testing.T) {
	published := time.Now().Add(-2 * time.Hour)
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tag_name":"v9.9.9","draft":false,"prerelease":false,"published_at":"` + published.UTC().Format(time.RFC3339) + `"}`))
	}))
	defer gh.Close()

	cases := []struct {
		name, build string
		minAge      time.Duration
		want        bool
	}{
		{"a release build, an hour-old release", "v0.1.0", time.Hour, true},
		{"a deploy past a tag", "v0.1.0-3-g1a2b3c4", time.Hour, false},
		{"a release too new", "v0.1.0", 3 * time.Hour, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root := t.TempDir()
			got := make(chan string, 1)
			s := New(Config{Token: "tok", Version: c.build,
				Index: &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")},
				Release: ReleaseConfig{On: true, API: gh.URL, First: 20 * time.Millisecond, Every: time.Hour, Auto: true, MinAge: c.minAge,
					Update: func(tag string) error { got <- tag; return nil }}})
			t.Cleanup(s.Close)
			select {
			case tag := <-got:
				if !c.want {
					t.Fatalf("installed %s", tag)
				}
				if tag != "v9.9.9" {
					t.Fatalf("installed %s", tag)
				}
				s.hub.mu.Lock()
				u := s.hub.update
				s.hub.mu.Unlock()
				if u != "v9.9.9" {
					t.Errorf("the hub's update is %q", u)
				}
			case <-time.After(time.Second):
				if c.want {
					t.Fatal("nothing installed within a second")
				}
			}
		})
	}
}

// A server on v0.1.0 hears from the fake GitHub that v9.9.9 is out: the
// pages get a release event, once, and the next snapshot names it.
func TestReleaseNotice(t *testing.T) {
	asks := 0
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/dakort-app/dakort/releases/latest" {
			http.NotFound(w, r)
			return
		}
		asks++
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tag_name":"v9.9.9","draft":false,"prerelease":false}`))
	}))
	defer gh.Close()

	root := t.TempDir()
	s := New(Config{Token: "tok", Version: "v0.1.0",
		Index:   &index.Index{Root: filepath.Join(root, "projects"), Registry: filepath.Join(root, "sessions")},
		Release: ReleaseConfig{On: true, API: gh.URL, First: 500 * time.Millisecond, Every: 50 * time.Millisecond}}) // First: the stream below connects before the first ask
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	t.Cleanup(s.Close)

	stream := func(ctx context.Context) *bufio.Scanner {
		req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/events", nil)
		req.AddCookie(&http.Cookie{Name: "dakort_token", Value: "tok"})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return bufio.NewScanner(resp.Body)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sc := stream(ctx)
	for sc.Scan() {
		line := sc.Text()
		if strings.Contains(line, `"release"`) {
			if !strings.Contains(line, `"latest":"v9.9.9"`) {
				t.Fatalf("release event without the tag: %s", line)
			}
			break
		}
	}
	if sc.Err() != nil {
		t.Fatal("no release event within 5 s")
	}

	// Asked again since (Every is short), announced once.
	time.Sleep(200 * time.Millisecond)
	if asks < 2 {
		t.Errorf("asked GitHub %d time(s); the loop should keep asking", asks)
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	sc2 := stream(ctx2)
	for sc2.Scan() {
		line := sc2.Text()
		if !strings.Contains(line, `"snapshot"`) {
			continue
		}
		if !strings.Contains(line, `"latest":"v9.9.9"`) {
			t.Fatalf("snapshot without the latest release: %s", line)
		}
		return
	}
	t.Fatal("no snapshot within 5 s")
}
