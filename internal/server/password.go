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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Dakort">
<meta name="theme-color" content="#fdfcfa">
<title>Dakort</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<script>
// The app's theme on this device if it has one, else the system's.
(function () {
  var t = null
  try { t = localStorage.getItem('dakort.theme') } catch (e) {}
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = t
  if (t === 'dark') document.querySelector('meta[name=theme-color]').content = '#1c1b19'
})()
</script>
<style>
* { -webkit-tap-highlight-color: transparent; } button:active { background-image: linear-gradient(rgba(0,0,0,.2), rgba(0,0,0,.2)); } :root[data-theme=dark] button:active { background-image: linear-gradient(rgba(255,255,255,.28), rgba(255,255,255,.28)); }
  :root { --frame: #f3f1ed; --panel: #fdfcfa; --line: #e2ded7; --line-strong: #8a857c; --text: #201e1b; --text-2: #4f4b45; --faint: #67625a; --accent: #2459b8; --on-accent: #ffffff; --err: #b3302a; --shadow: 0 1px 2px rgba(32,30,27,.05), 0 6px 20px -6px rgba(32,30,27,.14); color-scheme: light; }
  :root[data-theme=dark] { --frame: #141311; --panel: #1c1b19; --line: #383532; --line-strong: #7a756d; --text: #e6e3de; --text-2: #b9b4ab; --faint: #9a958c; --accent: #86b0f5; --on-accent: #0d1a33; --err: #f2766a; --shadow: 0 0 0 1px rgba(255,255,255,.05), 0 8px 24px -8px rgba(0,0,0,.6); color-scheme: dark; }
  body { font: 1rem/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100dvh; padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom); box-sizing: border-box; background: var(--frame); color: var(--text); }
  /* A phone: the card in the top part, so the keyboard leaves the fields and the button in sight. */
  /* Sizes in rem, so the browser's text size scales them; the body 16 px on a phone and 13 with a mouse, as in the app's UI text. */
  @media (pointer: fine) { body { font-size: 0.8125rem; } }
  @media (pointer: coarse) { body { place-items: start center; padding-top: max(10vh, env(safe-area-inset-top)); } }
  form { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 24px; width: min(360px, 100%); box-sizing: border-box; }
  img { display: block; border-radius: 8px; margin-bottom: 16px; }
  h1 { font-size: 0.9375rem; font-weight: 600; letter-spacing: -0.1px; margin: 0 0 4px; }
  label { display: block; margin: 12px 0 0; font-size: 0.75rem; font-weight: 500; color: var(--text-2); }
  input { font: inherit; font-size: 1rem; width: 100%; box-sizing: border-box; min-height: 44px; padding: 0 12px; margin: 4px 0 0; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--panel); color: var(--text); }
  input:focus { border-color: var(--accent); }
  input:not([type=checkbox]):focus-visible { outline: none; box-shadow: 0 0 0 1px var(--accent); }
  input::placeholder { color: var(--faint); opacity: 1; }
  button { font: inherit; font-weight: 500; width: 100%; min-height: 44px; margin-top: 16px; border: 0; border-radius: 6px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
  .show { display: flex; align-items: center; gap: 8px; min-height: 44px; margin: 4px 0 0; font-weight: 400; font-size: inherit; color: var(--text); }
  .show input { width: 20px; min-height: 20px; height: 20px; margin: 0; accent-color: var(--accent); }
  /* With a mouse: 32 px fields and button at the UI size, and a 28 px Show the password row (after the rules above, which it overrides). */
  @media (pointer: fine) { button { min-height: 32px; } input:not([type=checkbox]) { min-height: 32px; font-size: 0.8125rem; } .show { min-height: 28px; margin-top: 8px; } .show input { width: 14px; min-height: 14px; height: 14px; } }
  .hint { margin: 8px 0 0; font-size: 0.75rem; color: var(--text-2); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  p { margin: 0 0 12px; line-height: 1.45; }
  p:empty { display: none; }
  .err { color: var(--err); margin: 12px 0 0; } .err::before { content: "\2715\00a0"; font-weight: 700; } button:disabled { background: var(--line); border-color: var(--line); color: var(--text-2); filter: none; } .faint { color: var(--faint); } [hidden] { display: none; }
</style>
<form id="f" data-mode="{{mode}}">
  <img src="/favicon.svg" alt="" width="40" height="40">
  <h1 id="title">Log in to Dakort</h1>
  <p class="faint" id="note">{{note}}</p>
  <label id="w1">Password<input id="p1" type="password" autocomplete="current-password" autofocus></label>
  <label id="w2" hidden>The same again<input id="p2" type="password" autocomplete="new-password"></label>
  <p class="hint" id="hint" hidden>Set on your computer, in Other devices.</p>
  <label class="show" id="w3"><input id="show" type="checkbox"> Show the password</label>
  <p class="err" id="err" role="alert"></p>
  <button id="go">Log in</button>
</form>
<script>
const f = document.getElementById('f'), mode = f.dataset.mode
const p1 = document.getElementById('p1'), p2 = document.getElementById('p2')
const err = document.getElementById('err'), go = document.getElementById('go')
if (mode === 'setup') {
  document.getElementById('title').textContent = 'Choose a password'
  document.getElementById('note').textContent = 'At least 8 characters. Every device logs in with it once and then stays logged in for about\u00a0a\u00a0year.'
  p1.autocomplete = 'new-password'; document.getElementById('w2').hidden = false; go.textContent = 'Set password'
}
if (mode === 'login') document.getElementById('hint').hidden = false
if (mode === 'none') { document.getElementById('w1').hidden = true; document.getElementById('w3').hidden = true; go.hidden = true }
document.getElementById('show').onchange = (e) => { p1.type = p2.type = e.target.checked ? 'text' : 'password' }
// Safari on a phone shows a press (:active) only on a page that listens for touches.
document.addEventListener('touchstart', () => {}, { passive: true })
f.onsubmit = async (e) => {
  e.preventDefault(); err.textContent = ''
  if (mode === 'setup' && p1.value !== p2.value) { err.textContent = 'The two passwords differ.'; return }
  const label = go.textContent
  go.disabled = true; go.textContent = mode === 'setup' ? 'Setting…' : 'Logging in…'
  try {
    const r = await fetch(mode === 'setup' ? '/api/setup' : '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: p1.value }) })
    if (r.ok) { location.replace('/'); return }
    const b = await r.json().catch(() => ({}))
    err.textContent = b.error ? b.error.charAt(0).toUpperCase() + b.error.slice(1) + '.' : 'The server could not do that (HTTP ' + r.status + '). Try again.'
  } catch (x) { err.textContent = 'Dakort cannot be reached. Check the connection and try again.' }
  go.disabled = false; go.textContent = label
}
</script>
</html>
`
