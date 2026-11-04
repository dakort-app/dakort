package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Files of a session's folder, for the viewers. This is a security
// boundary: the server is reachable over Tailscale, so a request must
// never read outside the folder it names, and nothing served may run
// script with the app's cookie. See BRIEF, "Plan for piece 7".
//
//	GET /api/files/list?root=R&path=P   the entries of folder P (one level)
//	GET /api/files/raw?root=R&path=P    the bytes of file P; &download=1 marks it an attachment
//	GET /api/files/stat?root=R&path=P   size and mtime; complete for a PDF

const (
	maxRaw = 200 << 20 // a big PDF fits; anything larger is not viewed here
	// A PDF counts as complete once it ends in %%EOF and has not changed
	// for this long (pdflatex rewrites it in place).
	pdfSettle = 500 * time.Millisecond
)

// secretNames are refused at any depth, even inside a known folder.
var secretNames = map[string]bool{
	".ssh": true, ".gnupg": true, ".aws": true, ".azure": true, ".kube": true,
	".docker": true, ".netrc": true, "_netrc": true, ".git-credentials": true,
	".credentials.json": true,
}

// hiddenNames are left out of listings but may be opened.
var hiddenNames = map[string]bool{".git": true}

// served content types by extension. Everything else is a download: a
// type list from the OS (mime.TypeByExtension reads the Windows registry)
// could name something the browser renders and runs.
var servedTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
}

func forbidden(msg string) error { return &httpError{status: 403, msg: msg} }
func badPath(msg string) error   { return &httpError{status: 400, msg: msg} }

// canonical is the form roots are compared in: long names (no 8.3),
// symlinks resolved, cleaned, case-folded on Windows.
func canonical(p string) string {
	if long, err := filepath.EvalSymlinks(p); err == nil {
		p = long
	}
	return folderKey(p)
}

// fileRoot checks root and returns it canonical. It must be absolute, a
// folder the app knows (open on the home screen or some session's cwd),
// and not the home folder, a drive root, or anything above home.
func (s *Server) fileRoot(root string) (string, error) {
	if root == "" || !filepath.IsAbs(root) {
		return "", badPath("root must be an absolute folder")
	}
	root = filepath.Clean(root)
	key := canonical(root)
	if filepath.Dir(root) == root {
		return "", forbidden("a drive root cannot be opened")
	}
	if home, err := os.UserHomeDir(); err == nil {
		h := canonical(home)
		if key == h || strings.HasPrefix(h+string(filepath.Separator), strings.TrimSuffix(key, string(filepath.Separator))+string(filepath.Separator)) {
			return "", forbidden("the home folder and the folders above it cannot be opened")
		}
	}
	known := false
	for k, e := range s.store.entries() {
		if k == key || canonical(e.Path) == key {
			known = true
			break
		}
	}
	if !known {
		for _, sess := range s.idx.List() {
			if sess.Cwd != "" && (folderKey(sess.Cwd) == key || canonical(sess.Cwd) == key) {
				known = true
				break
			}
		}
	}
	if !known {
		return "", forbidden("not a folder this app knows")
	}
	return root, nil
}

// relPath checks a path inside the root. "" and "." name the root.
func relPath(p string) (string, error) {
	if p == "" || p == "." {
		return ".", nil
	}
	// On Windows `\Users\x` and `/x` are not absolute but are rooted;
	// IsLocal refuses them, `..`, drive-relative `C:x`, and `COM1:`. A
	// colon anywhere could name an alternate data stream (file.txt:s).
	if p[0] == '/' || p[0] == '\\' || strings.Contains(p, ":") || !filepath.IsLocal(p) {
		return "", badPath("bad path")
	}
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if secretNames[strings.ToLower(seg)] {
			return "", forbidden("that file holds credentials")
		}
	}
	return filepath.Clean(p), nil
}

// open resolves root and path from the request and opens the file through
// os.Root, which refuses anything that leads outside the root (`..`,
// symlinks and junctions pointing out, device names).
func (s *Server) open(r *http.Request) (*os.File, string, error) {
	q := r.URL.Query()
	root, err := s.fileRoot(q.Get("root"))
	if err != nil {
		return nil, "", err
	}
	p, err := relPath(q.Get("path"))
	if err != nil {
		return nil, "", err
	}
	rt, err := os.OpenRoot(root)
	if err != nil {
		return nil, "", &httpError{status: 404, msg: "folder not found"}
	}
	defer rt.Close()
	f, err := rt.Open(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, "", &httpError{status: 404, msg: "not found"}
		}
		return nil, "", badPath("cannot open that path")
	}
	return f, p, nil
}

type fileEntry struct {
	Name  string    `json:"name"`
	Dir   bool      `json:"dir,omitempty"`
	Size  int64     `json:"size"`
	MTime time.Time `json:"mtime"`
}

func (s *Server) listFiles(w http.ResponseWriter, r *http.Request) {
	f, _, err := s.open(r)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	defer f.Close()
	ents, err := f.ReadDir(-1)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, badPath("not a folder"))
		return
	}
	out := []fileEntry{}
	for _, e := range ents {
		n := e.Name()
		if hiddenNames[strings.ToLower(n)] || secretNames[strings.ToLower(n)] {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, fileEntry{Name: n, Dir: e.IsDir(), Size: fi.Size(), MTime: fi.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, out)
}

// snapshot reads a whole file into memory and closes it, so no handle is
// held while a slow phone receives it (that would block latexmk's
// renames), and what is sent is one generation of the file.
func snapshot(f *os.File) ([]byte, fs.FileInfo, error) {
	defer f.Close()
	fi, err := f.Stat() // from the handle; os.Stat can lag while a writer holds the file
	if err != nil {
		return nil, nil, err
	}
	if fi.IsDir() {
		return nil, nil, badPath("a folder, not a file")
	}
	if fi.Size() > maxRaw {
		return nil, nil, &httpError{status: 413, msg: "file too large to view"}
	}
	data, err := io.ReadAll(io.LimitReader(f, maxRaw+1))
	if err != nil {
		return nil, nil, err
	}
	return data, fi, nil
}

func pdfComplete(data []byte) bool {
	tail := data[max(0, len(data)-1024):]
	return bytes.Contains(tail, []byte("%%EOF"))
}

func (s *Server) rawFile(w http.ResponseWriter, r *http.Request) {
	f, p, err := s.open(r)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	data, _, err := snapshot(f)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	ext := strings.ToLower(filepath.Ext(p))
	if ext == ".pdf" && !pdfComplete(data) {
		// pdflatex is still writing it; pdf.js would quietly repair the
		// truncated file and show fewer pages.
		w.Header().Set("Retry-After", "1")
		s.reply(w, http.StatusOK)(nil, &httpError{status: 503, msg: "the PDF is being written"})
		return
	}
	sum := sha256.Sum256(data)
	etag := `"` + hex.EncodeToString(sum[:16]) + `"`
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox")
	h.Set("Cache-Control", "private, no-cache")
	h.Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	ct, ok := servedTypes[ext]
	if !ok {
		ct = "application/octet-stream"
	}
	h.Set("Content-Type", ct)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	// The Save button asks for a download: a phone's browser would open a
	// PDF in place despite the link's download attribute.
	if r.URL.Query().Get("download") != "" {
		h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(p)}))
	}
	// Written whole, never as ranges: a range request could stitch two
	// generations of a file being rewritten.
	w.Write(data)
}

type fileStat struct {
	Size     int64     `json:"size"`
	MTime    time.Time `json:"mtime"`
	Complete *bool     `json:"complete,omitempty"` // PDFs only
}

func (s *Server) statFile(w http.ResponseWriter, r *http.Request) {
	f, p, err := s.open(r)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	st := fileStat{Size: fi.Size(), MTime: fi.ModTime()}
	if strings.EqualFold(filepath.Ext(p), ".pdf") && !fi.IsDir() {
		tail := make([]byte, min(fi.Size(), 1024))
		ok := false
		if _, err := f.ReadAt(tail, fi.Size()-int64(len(tail))); err == nil || errors.Is(err, io.EOF) {
			ok = bytes.Contains(tail, []byte("%%EOF")) && time.Since(fi.ModTime()) > pdfSettle
		}
		st.Complete = &ok
	}
	writeJSON(w, st)
}
