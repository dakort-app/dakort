package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// One user, one secret. The token is created on first run and kept in a
// file only the user can read; visiting /login?token=T once per device
// sets a long-lived cookie holding it.
const cookieName = "dakort_token"

// The cookie's name before the project was renamed (2026-11-09). A
// device still carrying it is let in once and given the new one, so the
// rename logs nobody out. Remove after a release or two.
const oldCookieName = "made_token"

// LoadToken reads the token at path, creating it on first run.
func LoadToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		if t := strings.TrimSpace(string(data)); len(t) >= 32 {
			return t, nil
		}
		return "", errors.New("token file " + path + " is too short; delete it to make a new one")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	var b [32]byte
	rand.Read(b[:])
	t := hex.EncodeToString(b[:])
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(t+"\n"), 0o600); err != nil {
		return "", err
	}
	return t, nil
}

func (s *Server) validToken(t string) bool {
	return t != "" && subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
}

// login is the password page, or, with ?token=, the token link, which
// still works (and is what the tests use).
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !r.URL.Query().Has("token") {
		s.loginPage(w, r)
		return
	}
	if !s.validToken(r.URL.Query().Get("token")) {
		http.Error(w, "wrong token", http.StatusUnauthorized)
		return
	}
	s.setCookie(w)
	// Drop the token from the address bar and history.
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// auth lets in a request carrying the cookie, and only from this app's
// own pages: a POST another page fires at it, riding the cookie, is
// refused before the cookie is looked at. SameSite=Strict on the cookie
// (setCookie) is not enough alone: a page on the same host at another
// port (the fork's, on 3001) counts as the same site and gets it sent. The browser says where a request came from in Sec-Fetch-Site,
// or, on plain HTTP, where it sends no Sec-Fetch headers, in Origin;
// http.CrossOriginProtection checks either. Programs (the install script, curl) send
// neither header and pass.
func (s *Server) auth(next http.Handler) http.Handler {
	return http.NewCrossOriginProtection().Handler(s.cookie(next))
}

func (s *Server) cookie(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login", "/api/login", "/api/setup":
			next.ServeHTTP(w, r)
			return
		}
		if c, err := r.Cookie(cookieName); err == nil && s.validToken(c.Value) {
			next.ServeHTTP(w, r)
			return
		}
		if c, err := r.Cookie(oldCookieName); err == nil && s.validToken(c.Value) {
			s.setCookie(w)
			http.SetCookie(w, &http.Cookie{Name: oldCookieName, Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
			next.ServeHTTP(w, r)
			return
		}
		// Refused: say what the device sent (cookie names only, never
		// values), so a login prompt nobody expected can be explained.
		var names []string
		for _, c := range r.Cookies() {
			names = append(names, c.Name)
		}
		log.Printf("not logged in: %s %s from %s; cookies %v; %s", r.Method, r.URL.Path, r.RemoteAddr, names, r.UserAgent())
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.Error(w, "not logged in", http.StatusUnauthorized)
			return
		}
		s.loginPage(w, r)
	})
}
