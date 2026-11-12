package server

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"html"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// A password instead of pasting the token: the login page takes it and
// sets the same cookie the token link sets. The password is chosen on the
// computer itself (a request straight to the loopback address, not
// through Tailscale Serve), so nobody else on the tailnet can claim it
// first: in the Other devices panel (devices.go), or on the login page
// when the computer's own browser has no cookie. Stored as PBKDF2-SHA256
// with a random salt, never as text.
//
//	GET  /login              the login page (or, with ?token=, the old link)
//	POST /api/login          {password}: sets the cookie
//	POST /api/setup          {password}: chooses the password; local only, once (the login page's way)

const (
	pbkdfIter   = 600_000 // OWASP's figure for PBKDF2-SHA256
	minPassword = 8
	// Guessing: every wrong answer costs a second, and after maxFails in a
	// row the login closes for lockFor.
	maxFails = 5
	lockFor  = 5 * time.Minute
)

type passwordFile struct {
	Salt []byte `json:"salt"`
	Iter int    `json:"iter"`
	Hash []byte `json:"hash"`
}

type passwords struct {
	file string // empty: no passwords (tests that use the token only)

	mu     sync.Mutex
	fails  int
	locked time.Time
}

func (p *passwords) load() (*passwordFile, error) {
	if p.file == "" {
		return nil, fs.ErrNotExist
	}
	data, err := os.ReadFile(p.file)
	if err != nil {
		return nil, err
	}
	var pf passwordFile
	if err := json.Unmarshal(data, &pf); err != nil || len(pf.Hash) == 0 || pf.Iter <= 0 {
		return nil, errors.New("password file " + p.file + " is damaged; delete it and choose a new password")
	}
	return &pf, nil
}

func (p *passwords) isSet() bool {
	_, err := p.load()
	return err == nil
}

func (p *passwords) set(pw string) error {
	if p.file == "" {
		return errors.New("passwords are not enabled")
	}
	salt := make([]byte, 16)
	rand.Read(salt)
	h, err := pbkdf2.Key(sha256.New, pw, salt, pbkdfIter, 32)
	if err != nil {
		return err
	}
	data, _ := json.Marshal(passwordFile{Salt: salt, Iter: pbkdfIter, Hash: h})
	if err := os.MkdirAll(filepath.Dir(p.file), 0o700); err != nil {
		return err
	}
	tmp := p.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.file)
}

// check compares a password, counting failures. It returns a 429 error
// while locked.
func (p *passwords) check(pw string) error {
	p.mu.Lock()
	if time.Now().Before(p.locked) {
		p.mu.Unlock()
		return &httpError{status: 429, msg: "too many wrong passwords; try again in a few minutes"}
	}
	p.mu.Unlock()
	pf, err := p.load()
	if err != nil {
		return &httpError{status: 409, msg: "no password has been chosen yet"}
	}
	h, err := pbkdf2.Key(sha256.New, pw, pf.Salt, pf.Iter, len(pf.Hash))
	ok := err == nil && subtle.ConstantTimeCompare(h, pf.Hash) == 1
	p.mu.Lock()
	defer p.mu.Unlock()
	if ok {
		p.fails = 0
		return nil
	}
	p.fails++
	if p.fails >= maxFails {
		p.fails = 0
		p.locked = time.Now().Add(lockFor)
	}
	time.Sleep(time.Second)
	return &httpError{status: 401, msg: "wrong password"}
}

// direct says whether a request came straight to a loopback address, from
// a program on this machine, rather than through Tailscale Serve, which
// adds X-Forwarded-For and asks for the tailnet name in Host.
func direct(r *http.Request) bool {
	if r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Tailscale-User-Login") != "" {
		return false
	}
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	if host != "localhost" {
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			return false
		}
	}
	rhost, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(rhost)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) setCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    s.token,
		Path:     "/",
		MaxAge:   400 * 24 * 3600, // the longest browsers keep a cookie
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		// Not Secure: on the laptop itself the app is plain HTTP.
	})
}

func (s *Server) passwordLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if err := s.pw.check(req.Password); err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	s.setCookie(w)
	writeJSON(w, struct{}{})
}

func (s *Server) passwordSetup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	switch {
	case s.pw.isSet():
		s.reply(w, http.StatusOK)(nil, &httpError{status: 409, msg: "a password is already set"})
	case !direct(r):
		s.reply(w, http.StatusOK)(nil, &httpError{status: 403, msg: "the password is chosen on the computer itself, at http://127.0.0.1"})
	case len([]rune(req.Password)) < minPassword:
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "use at least 8 characters"})
	default:
		if err := s.pw.set(req.Password); err != nil {
			s.reply(w, http.StatusOK)(nil, err)
			return
		}
		s.setCookie(w)
		writeJSON(w, struct{}{})
	}
}

// loginPage is a small page of its own: the app's bundle is behind the login.
func (s *Server) loginPage(w http.ResponseWriter, r *http.Request) {
	mode, note := "login", ""
	if !s.pw.isSet() {
		if direct(r) {
			mode = "setup"
		} else {
			mode, note = "none", "No password yet. On the computer, tap the devices icon in Dakort (beside the moon) and choose one."
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet && r.URL.Path != "/login" {
		w.WriteHeader(http.StatusUnauthorized)
	}
	page := strings.NewReplacer("{{mode}}", mode, "{{note}}", html.EscapeString(note)).Replace(loginHTML)
	w.Write([]byte(page))
}

func portOf(r *http.Request) string {
	if _, port, err := net.SplitHostPort(r.Host); err == nil {
		return ":" + port
	}
	return ""
}

const loginHTML = `<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dakort</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; display: grid; place-items: center; min-height: 100dvh; background: #f8f8f8; color: #1f1f1f; }
  form { background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 24px; width: min(320px, 88vw); }
  h1 { font-size: 18px; margin: 0 0 12px; }
  input { font: inherit; width: 100%; box-sizing: border-box; padding: 8px 10px; margin: 6px 0; border: 1px solid #ccc; border-radius: 6px; }
  button { font: inherit; width: 100%; padding: 8px; margin-top: 8px; border: 0; border-radius: 6px; background: #005fb8; color: #fff; }
  p { margin: 6px 0; font-size: 14px; }
  .err { color: #c72e2e; } .faint { color: #6f6f6f; } [hidden] { display: none; }
</style>
<form id="f" data-mode="{{mode}}">
  <h1 id="title">Dakort</h1>
  <p class="faint" id="note">{{note}}</p>
  <input id="p1" type="password" autocomplete="current-password" placeholder="Password" autofocus>
  <input id="p2" type="password" autocomplete="new-password" placeholder="The same again" hidden>
  <button id="go">Log in</button>
  <p class="err" id="err"></p>
</form>
<script>
const f = document.getElementById('f'), mode = f.dataset.mode
const p1 = document.getElementById('p1'), p2 = document.getElementById('p2')
const err = document.getElementById('err'), go = document.getElementById('go')
if (mode === 'setup') {
  document.getElementById('title').textContent = 'Choose a password'
  document.getElementById('note').textContent = 'At least 8 characters. Every device logs in with it; each stays logged in for about a year.'
  p1.autocomplete = 'new-password'; p2.hidden = false; go.textContent = 'Set password'
}
if (mode === 'none') { p1.hidden = true; go.hidden = true }
f.onsubmit = async (e) => {
  e.preventDefault(); err.textContent = ''
  if (mode === 'setup' && p1.value !== p2.value) { err.textContent = 'The two passwords differ.'; return }
  go.disabled = true
  try {
    const r = await fetch(mode === 'setup' ? '/api/setup' : '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: p1.value }) })
    if (r.ok) { location.replace('/'); return }
    const b = await r.json().catch(() => ({}))
    err.textContent = b.error || ('HTTP ' + r.status)
  } catch (x) { err.textContent = String(x) }
  go.disabled = false
}
</script>
</html>
`
