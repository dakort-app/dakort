package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// A newer release is announced to every page: the server asks GitHub for
// the latest release now and then, and when its tag is newer than this
// build the pages get a "release" event (and every later snapshot names
// it), so the phone can say "v0.2.0 is out; on the computer: dakort
// update". A build that is not a release (dev, or a commit past a tag)
// is never behind. GitHub answering nothing (offline, a private repo) is
// quiet: the notice is a courtesy.
//
//	release   Latest: the newest release's tag, newer than this build
//	          Update: that tag once the server is installing it by itself
//
// With Auto on, a release build installs the newer release by itself:
// Update runs `dakort update` (which fetches, checks, stages and asks
// this server to restart once nothing runs, held processes included),
// once the release has been out for MinAge, so a release pulled within
// the hour never reaches anyone. Only a build that is exactly a release
// (v0.1.1, not v0.1.1-3-g... from a deploy of the dev tree, which would
// be replaced by the release it is past) updates itself; see autoUpdates.

type ReleaseConfig struct {
	On     bool
	Repo   string        // owner/name; releaseRepo when empty
	API    string        // the GitHub API's base; api.github.com when empty (tests)
	Every  time.Duration // how often to ask; releaseEvery when zero
	First  time.Duration // the wait before the first ask; releaseFirst when zero
	Auto   bool          // install a newer release by itself, through Update
	MinAge time.Duration // how long a release must have been out before Auto takes it; releaseMinAge when zero
	Update func(tag string) error
}

const (
	releaseRepo   = "dakort-app/dakort"
	releaseAPI    = "https://api.github.com"
	releaseEvery  = 6 * time.Hour
	releaseFirst  = time.Minute
	releaseMinAge = time.Hour
)

func (c ReleaseConfig) withDefaults() ReleaseConfig {
	if c.MinAge == 0 {
		c.MinAge = releaseMinAge
	}
	if c.Repo == "" {
		c.Repo = releaseRepo
	}
	if c.API == "" {
		c.API = releaseAPI
	}
	if c.Every == 0 {
		c.Every = releaseEvery
	}
	if c.First == 0 {
		c.First = releaseFirst
	}
	return c
}

func (s *Server) releaseLoop(c ReleaseConfig) {
	defer s.done.Done()
	wait := time.NewTimer(c.First)
	defer wait.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-wait.C:
		}
		s.checkRelease(c)
		wait.Reset(c.Every)
	}
}

// checkRelease asks once and announces a newer tag, once per tag; with
// Auto on it then installs the tag, once it is old enough.
func (s *Server) checkRelease(c ReleaseConfig) {
	tag, published, err := latestTag(c)
	if err != nil {
		log.Printf("the latest release: %v", err)
		return
	}
	if !NewerRelease(s.hub.build, tag) {
		return
	}
	s.hub.mu.Lock()
	seen := s.hub.latest == tag
	s.hub.latest = tag
	s.hub.mu.Unlock()
	if !seen {
		log.Printf("%s is out (this is %s)", tag, s.hub.build)
		s.hub.publish(Ev{Type: "release", Latest: tag})
	}
	if !c.Auto || c.Update == nil || !autoUpdates(s.hub.build) {
		return
	}
	if age := time.Since(published); age < c.MinAge {
		log.Printf("%s has been out %s; installing it after %s", tag, age.Round(time.Minute), c.MinAge)
		return
	}
	s.hub.mu.Lock()
	going := s.hub.update == tag
	s.hub.update = tag
	s.hub.mu.Unlock()
	if going {
		return
	}
	log.Printf("installing %s", tag)
	s.hub.publish(Ev{Type: "release", Latest: tag, Update: tag})
	s.done.Add(1)
	go func() {
		defer s.done.Done()
		if err := c.Update(tag); err != nil {
			log.Printf("installing %s: %v", tag, err)
			s.hub.mu.Lock()
			s.hub.update = ""
			s.hub.mu.Unlock()
			s.hub.publish(Ev{Type: "release", Latest: tag})
		}
	}()
}

// autoUpdates reports whether a build may replace itself with a release:
// one that is exactly a release tag (a release candidate included), not
// a deploy past a tag and not a dev build.
func autoUpdates(build string) bool {
	return releaseRe.MatchString(build) && !describeRe.MatchString(build)
}

// latestTag is the tag of the repo's latest release (not a draft or a
// pre-release, as GitHub counts them) and when it was published (now,
// when GitHub does not say, so Auto waits).
func latestTag(c ReleaseConfig) (string, time.Time, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", c.API+"/repos/"+c.Repo+"/releases/latest", nil)
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", time.Time{}, fmt.Errorf("%s: %s", req.URL, resp.Status)
	}
	var r struct {
		Tag       string    `json:"tag_name"`
		Published time.Time `json:"published_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return "", time.Time{}, err
	}
	if r.Tag == "" {
		return "", time.Time{}, fmt.Errorf("%s: no tag_name", req.URL)
	}
	if r.Published.IsZero() {
		r.Published = time.Now()
	}
	return r.Tag, r.Published, nil
}

// A version as git describe prints it: the tag, and past it the commits
// since and the hash (v0.1.0-3-g1a2b3c4, maybe -dirty).
var (
	releaseRe  = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$`)
	describeRe = regexp.MustCompile(`-\d+-g[0-9a-f]+(-dirty)?$`)
	digitsRe   = regexp.MustCompile(`\d+`)
)

// NewerRelease reports whether the release tag is newer than this build.
// A pre-release (v0.1.0-rc1) is older than its release and than a later
// pre-release (rc2). A build past a tag (v0.1.0-3-g..., a deploy of the
// dev tree by ship.sh, so only the developers' machines) is never behind:
// the next release is cut from that very tree, and the page used to tell
// the developer to run dakort update, which would have put the release
// over a newer deploy (seen 2026-11-11, the day v0.1.1 went out). A build
// that is no version at all ("dev") is never behind either.
func NewerRelease(build, tag string) bool {
	if describeRe.MatchString(build) {
		return false
	}
	b := releaseRe.FindStringSubmatch(build)
	t := releaseRe.FindStringSubmatch(tag)
	if b == nil || t == nil {
		return false
	}
	for i := 1; i <= 3; i++ {
		bi, _ := strconv.Atoi(b[i])
		ti, _ := strconv.Atoi(t[i])
		if bi != ti {
			return ti > bi
		}
	}
	// The same number: a release beats a pre-release (and a build past
	// one); between two pre-releases the later one (rc2 after rc1, rc10
	// after rc9).
	switch {
	case b[4] == "":
		return false
	case t[4] == "":
		return true
	default:
		return prerelease(t[4]) > prerelease(b[4])
	}
}

// prerelease makes "rc10" sort after "rc9" by padding its numbers.
func prerelease(p string) string {
	return digitsRe.ReplaceAllStringFunc(strings.ToLower(p), func(d string) string { return fmt.Sprintf("%08d", mustAtoi(d)) })
}

func mustAtoi(d string) int {
	n, _ := strconv.Atoi(d)
	return n
}
