package server

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Uploading a file into a session's folder, so the agent can open it with
// its own tools (images go inside the message instead; see Composer).
//
//	POST /api/files/upload?root=R&dir=D&name=N   body: the file's bytes
//
// D is a folder inside R ("" for R itself) and N the file's own name. The
// file is created, never written over: if N is taken the upload becomes
// "N (2).ext", "N (3).ext", and so on. Not inside .git, not under a name
// that holds credentials, never through a link out of R (os.Root). The
// reply is the path it was saved at, relative to R with forward slashes.
// The body is sent as application/octet-stream: a form post from another
// site is stopped by the cross-origin check in front of every route, and
// asking for this type keeps a plain form from posting here regardless.

const maxUpload = 100 << 20

func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request) {
	fail := s.reply(w, http.StatusOK)
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/octet-stream" {
		http.Error(w, "send application/octet-stream", http.StatusUnsupportedMediaType)
		return
	}
	if r.ContentLength > maxUpload {
		fail(nil, &httpError{status: 413, msg: fmt.Sprintf("larger than %d MB; copy it into the folder another way", maxUpload>>20)})
		return
	}
	q := r.URL.Query()
	root, err := s.fileRoot(q.Get("root"))
	if err != nil {
		fail(nil, err)
		return
	}
	dir, err := relPath(q.Get("dir"))
	if err != nil {
		fail(nil, err)
		return
	}
	name, ok := usableName(q.Get("name"))
	if !ok {
		fail(nil, badPath("not a usable file name"))
		return
	}
	// The same checks as a path read back later: device names (CON, NUL)
	// and names that hold credentials are refused.
	if _, err := relPath(filepath.Join(dir, name)); err != nil {
		fail(nil, err)
		return
	}
	for _, seg := range strings.FieldsFunc(dir, func(r rune) bool { return r == '/' || r == '\\' }) {
		if strings.EqualFold(seg, ".git") {
			fail(nil, forbidden("nothing is uploaded inside .git"))
			return
		}
	}
	rt, err := os.OpenRoot(root)
	if err != nil {
		fail(nil, &httpError{status: 404, msg: "folder not found"})
		return
	}
	defer rt.Close()
	if fi, err := rt.Stat(dir); err != nil || !fi.IsDir() {
		fail(nil, &httpError{status: 404, msg: "that folder is gone"})
		return
	}
	var f *os.File
	var rel string
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if stem == "" { // ".env": the whole name is the stem
		stem, ext = name, ""
	}
	for n := 1; n <= 100 && f == nil; n++ {
		try := name
		if n > 1 {
			try = fmt.Sprintf("%s (%d)%s", stem, n, ext)
		}
		rel = filepath.Join(dir, try)
		f, err = rt.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil && !errors.Is(err, fs.ErrExist) {
			fail(nil, badPath("cannot create a file there"))
			return
		}
	}
	if f == nil {
		fail(nil, badPath("too many files named "+name))
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxUpload)
	_, err = io.Copy(f, body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		// Half a file would look like the real thing to the agent.
		rt.Remove(rel)
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			fail(nil, &httpError{status: 413, msg: fmt.Sprintf("larger than %d MB; copy it into the folder another way", maxUpload>>20)})
		} else {
			fail(nil, &httpError{status: 500, msg: "the upload broke off"})
		}
		return
	}
	fail(struct {
		Path string `json:"path"`
	}{path.Clean(filepath.ToSlash(rel))}, nil)
}
