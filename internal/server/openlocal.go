package server

import (
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// HTML files are never rendered inside the app: a page's scripts would run
// as the user. On the computer itself, "Open in browser" has the system
// open the file, as a double-click would, outside the app's origin, where
// its styles, pictures and scripts all work. Elsewhere (a phone) the raw
// file can be opened in a tab as text/html under the sandbox, which runs
// no script and has no cookie (rawFile, &html=1). Office files the app
// does not show (spreadsheets, slides, OpenDocument text) open the same
// way, in whatever the computer has for them.
//
//	GET  /api/here                          {local}: is this request from the computer the server runs on
//	POST /api/files/open?root=R&path=P      open an HTML or office file with the computer's own program; local requests only

var htmlExts = map[string]bool{".html": true, ".htm": true}

// The office documents the file view offers to open on the computer.
// Documents only, never anything that runs (no macro-enabled .xlsm): the
// system hands each to its registered program, so the list must stay one
// of document types.
var officeExts = map[string]bool{
	".xlsx": true, ".xls": true, ".ods": true, ".numbers": true,
	".pptx": true, ".ppt": true, ".odp": true, ".key": true,
	".odt": true, ".doc": true, ".rtf": true,
}

// onThisMachine says whether a request came from a browser on the computer
// the server runs on: straight to a loopback address, or through Tailscale
// Serve from one of this computer's own addresses (a browser here using the
// tailnet name). Serve proxies from loopback and appends the real client to
// X-Forwarded-For, so its last entry is the one Serve wrote; anything
// before it came from the client and is not trusted.
func onThisMachine(r *http.Request) bool {
	if direct(r) {
		return true
	}
	rhost, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip := net.ParseIP(rhost); ip == nil || !ip.IsLoopback() {
		return false
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return false
	}
	parts := strings.Split(xff, ",")
	ip := net.ParseIP(strings.TrimSpace(parts[len(parts)-1]))
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.Equal(ip) {
			return true
		}
	}
	return false
}

func (s *Server) here(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"local": onThisMachine(r)})
}

// openLocal opens an HTML or office file of a project with the system's
// program for it. Only for a request from this computer, so a phone cannot
// make windows appear on it, and only for those document types, so it
// never starts a program.
func (s *Server) openLocal(w http.ResponseWriter, r *http.Request) {
	if !onThisMachine(r) {
		s.reply(w, http.StatusOK)(nil, forbidden("only from a browser on the computer Dakort runs on"))
		return
	}
	f, p, err := s.open(r) // confines the path to the folder
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	f.Close()
	if ext := strings.ToLower(filepath.Ext(p)); !htmlExts[ext] && !officeExts[ext] {
		s.reply(w, http.StatusOK)(nil, badPath("only HTML and office documents open on the computer"))
		return
	}
	root, err := s.fileRoot(r.URL.Query().Get("root"))
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	if err := launch(filepath.Join(root, filepath.FromSlash(p))); err != nil {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 500, msg: "opening the browser: " + err.Error()})
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// launch hands a file to the system's default program for it, as a
// double-click does: for an .html file, the browser.
func launch(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// FileProtocolHandler opens with the file's associated program; it
		// takes the rest of its command line as the path, spaces and all.
		cmd = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
