package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Deleting a file from the explorer moves it into the app's trash, beside
// deleted sessions, so a mis-tap is undone with one more tap; emptyTrash
// removes entries older than trashKeep. Files only, never a folder, never
// anything inside .git or a credentials file, never through a link out of
// the folder.
//
//	POST /api/files/delete?root=R&path=P   {}: into the trash; answers {trash}
//	POST /api/files/restore                {trash}: back where it was; answers {path}

// Every file trash entry is named like this; nothing else is ever moved
// out of the trash or removed from it.
var fileTrashName = regexp.MustCompile(`^made-filetrash-[0-9]+-[0-9a-f]{16}$`)

type fileTrashMeta struct {
	Root    string    `json:"root"`
	Path    string    `json:"path"` // inside Root, with forward slashes
	Deleted time.Time `json:"deleted"`
}

// trashedFile is the name the file itself has inside its entry.
const trashedFile = "file"

func (s *Server) deleteFile(w http.ResponseWriter, r *http.Request) {
	if !readJSON(w, r, &struct{}{}) {
		return
	}
	fail := s.reply(w, http.StatusOK)
	if s.trash == "" {
		fail(nil, &httpError{status: 503, msg: "this server has no trash, so it deletes nothing"})
		return
	}
	q := r.URL.Query()
	root, err := s.fileRoot(q.Get("root"))
	if err != nil {
		fail(nil, err)
		return
	}
	p, err := relPath(q.Get("path"))
	if err != nil {
		fail(nil, err)
		return
	}
	if p == "." {
		fail(nil, badPath("the project folder itself is not deleted here"))
		return
	}
	if insideGit(p) {
		fail(nil, forbidden("nothing inside .git is deleted here"))
		return
	}
	rt, err := os.OpenRoot(root)
	if err != nil {
		fail(nil, &httpError{status: 404, msg: "folder not found"})
		return
	}
	defer rt.Close()
	// Through the root: a link on the way that leads out is refused. The
	// file itself must be a plain file (a link would be moved, not what
	// it points at, which is fine, but a folder is not deleted here).
	fi, err := rt.Lstat(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			fail(nil, &httpError{status: 404, msg: "the file is gone"})
		} else {
			fail(nil, badPath("cannot reach that file"))
		}
		return
	}
	if !fi.Mode().IsRegular() {
		fail(nil, badPath("only files are deleted here, not folders"))
		return
	}
	var rnd [8]byte
	rand.Read(rnd[:])
	name := "made-filetrash-" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "-" + hex.EncodeToString(rnd[:])
	dir := filepath.Join(s.trash, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fail(nil, err)
		return
	}
	meta, _ := json.Marshal(fileTrashMeta{Root: root, Path: filepath.ToSlash(p), Deleted: time.Now()})
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o600); err != nil {
		fail(nil, err)
		return
	}
	if err := moveFile(filepath.Join(root, p), filepath.Join(dir, trashedFile)); err != nil {
		os.Remove(filepath.Join(dir, "meta.json"))
		os.Remove(dir) // empty again; Remove refuses otherwise
		fail(nil, &httpError{status: 409, msg: "could not delete it (is it open in another program?)"})
		return
	}
	writeJSON(w, struct {
		Trash string `json:"trash"`
	}{name})
}

func (s *Server) restoreFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Trash string `json:"trash"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	fail := s.reply(w, http.StatusOK)
	if !fileTrashName.MatchString(req.Trash) || s.trash == "" {
		fail(nil, badPath("bad trash entry"))
		return
	}
	dir := filepath.Join(s.trash, req.Trash)
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	var meta fileTrashMeta
	if err != nil || json.Unmarshal(data, &meta) != nil {
		fail(nil, &httpError{status: 404, msg: "no such trash entry"})
		return
	}
	// The same checks as the delete: the folder must still be one the app
	// knows, the path inside it.
	root, err := s.fileRoot(meta.Root)
	if err != nil {
		fail(nil, err)
		return
	}
	p, err := relPath(filepath.FromSlash(meta.Path))
	if err != nil || p == "." || insideGit(p) {
		fail(nil, &httpError{status: 404, msg: "no such trash entry"})
		return
	}
	rt, err := os.OpenRoot(root)
	if err != nil {
		fail(nil, &httpError{status: 404, msg: "folder not found"})
		return
	}
	defer rt.Close()
	if _, err := rt.Lstat(p); err == nil {
		fail(nil, &httpError{status: 409, msg: "a file of that name is there again"})
		return
	}
	if d := filepath.Dir(p); d != "." {
		if err := rt.MkdirAll(d, 0o755); err != nil {
			fail(nil, badPath("cannot make its folder again"))
			return
		}
	}
	if err := moveFile(filepath.Join(dir, trashedFile), filepath.Join(root, p)); err != nil {
		fail(nil, &httpError{status: 500, msg: "could not restore it"})
		return
	}
	os.Remove(filepath.Join(dir, "meta.json"))
	os.Remove(dir) // empty by now; Remove refuses otherwise
	writeJSON(w, struct {
		Path string `json:"path"`
	}{meta.Path})
}

func insideGit(p string) bool {
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if strings.EqualFold(seg, ".git") {
			return true
		}
	}
	return false
}

// moveFile renames from to to; across drives (the project on D:, the trash
// on C:) it copies, and removes from only once the copy is complete. If
// from cannot be removed (open in another program on Windows), the copy
// goes and from stays.
func moveFile(from, to string) error {
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		in.Close()
		return err
	}
	_, err = io.Copy(out, in)
	in.Close()
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Remove(from)
	}
	if err != nil {
		os.Remove(to) // the copy this call made, by its exact name
		return err
	}
	return nil
}
