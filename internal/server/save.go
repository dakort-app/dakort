package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strings"
	"unicode/utf8"
)

// Saving a text file edited in the code view.
//
//	POST /api/files/save?root=R&path=P  {text, base}
//
// base is the ETag the viewer loaded the file with (rawFile: a hash of the
// content). If the file has changed since, by Claude, another session or
// another editor, the save is refused with 412 and nothing is written;
// base "*" overwrites anyway. Only an existing UTF-8 text file is written,
// in place (its permissions, links and owner stay), never inside .git.
// The text comes with "\n" line ends (CodeMirror's); a file that used
// "\r\n" gets them back, and a leading BOM is kept.

const maxSave = 8 << 20

type saveRequest struct {
	Text string `json:"text"`
	Base string `json:"base"`
}

func contentTag(data []byte) string {
	sum := sha256.Sum256(data)
	return `"` + hex.EncodeToString(sum[:16]) + `"`
}

var bom = []byte{0xEF, 0xBB, 0xBF}

// crlf says whether a file's lines end mostly in "\r\n".
func crlf(data []byte) bool {
	n := bytes.Count(data, []byte("\n"))
	return n > 0 && bytes.Count(data, []byte("\r\n"))*2 > n
}

// asSaved turns the editor's text into the bytes to write, in the old
// file's conventions.
func asSaved(old []byte, text string) []byte {
	out := []byte(strings.ReplaceAll(text, "\r\n", "\n"))
	if crlf(old) {
		out = bytes.ReplaceAll(out, []byte("\n"), []byte("\r\n"))
	}
	if bytes.HasPrefix(old, bom) && !bytes.HasPrefix(out, bom) {
		out = append(append([]byte{}, bom...), out...)
	}
	return out
}

// editable says why a file's bytes cannot be edited as text, or "".
func editable(data []byte) string {
	if bytes.IndexByte(data[:min(len(data), 8192)], 0) >= 0 {
		return "a binary file cannot be edited here"
	}
	if !utf8.Valid(data) {
		return "the file is not UTF-8 text; saving would damage it"
	}
	return ""
}

func (s *Server) saveFile(w http.ResponseWriter, r *http.Request) {
	var req saveRequest
	if !readJSON(w, r, &req) {
		return
	}
	fail := s.reply(w, http.StatusOK)
	if len(req.Text) > maxSave {
		fail(nil, &httpError{status: 413, msg: "too large to save here"})
		return
	}
	if req.Base == "" {
		fail(nil, badPath("base is required"))
		return
	}
	root, err := s.fileRoot(r.URL.Query().Get("root"))
	if err != nil {
		fail(nil, err)
		return
	}
	p, err := relPath(r.URL.Query().Get("path"))
	if err != nil {
		fail(nil, err)
		return
	}
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if strings.EqualFold(seg, ".git") {
			fail(nil, forbidden("files inside .git are not edited here"))
			return
		}
	}
	rt, err := os.OpenRoot(root)
	if err != nil {
		fail(nil, &httpError{status: 404, msg: "folder not found"})
		return
	}
	defer rt.Close()
	f, err := rt.OpenFile(p, os.O_RDWR, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			fail(nil, &httpError{status: 404, msg: "the file is gone"})
		} else {
			fail(nil, badPath("cannot open that file for writing"))
		}
		return
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		fail(nil, badPath("not a file"))
		return
	}
	old, err := io.ReadAll(io.LimitReader(f, maxSave+1))
	if err != nil {
		fail(nil, err)
		return
	}
	if len(old) > maxSave {
		fail(nil, &httpError{status: 413, msg: "too large to save here"})
		return
	}
	if why := editable(old); why != "" {
		fail(nil, &httpError{status: 422, msg: why})
		return
	}
	if req.Base != "*" && req.Base != contentTag(old) {
		fail(nil, &httpError{status: 412, msg: "the file changed since you opened it"})
		return
	}
	data := asSaved(old, req.Text)
	if _, err := f.WriteAt(data, 0); err != nil {
		fail(nil, err)
		return
	}
	if err := f.Truncate(int64(len(data))); err != nil {
		fail(nil, err)
		return
	}
	writeJSON(w, map[string]string{"etag": contentTag(data)})
}
