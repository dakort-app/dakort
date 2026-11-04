package server

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// SyncTeX: from a line of a .tex file to its spot in the PDF, and back.
// The server runs the `synctex` tool that comes with MiKTeX and TeX Live
// rather than parsing .synctex.gz itself. It needs the PDF compiled with
// -synctex=1. Paths are checked like every other file route, and the
// tool is run without a shell.
//
//	GET /api/files/synctex/view?root=R&tex=T&line=N[&pdf=P]   spots in the PDF
//	GET /api/files/synctex/edit?root=R&pdf=P&page=N&x=X&y=Y  the source line
//
// The tool matches input files by the exact path pdflatex recorded, and
// that follows how pdflatex's working folder was spelled: run from
// C:\Users\ALEXTH~1\... it records the 8.3 form, from the long folder the
// long form (both measured; any other spelling gets "No tag for ...").
// So the name is looked up in the .synctex file itself.

const synctexTimeout = 10 * time.Second

type syncBox struct {
	Page int     `json:"page"` // 1-based
	X    float64 `json:"x"`    // left edge, PDF points from the page's top-left
	Y    float64 `json:"y"`    // top edge
	W    float64 `json:"w"`
	H    float64 `json:"h"`
}

type syncLine struct {
	Path    string `json:"path,omitempty"` // relative to the root, slashes
	Line    int    `json:"line"`
	Outside bool   `json:"outside,omitempty"` // a file outside the folder (a class, a package)
}

// longRoot is the root in the long form the tool and pdflatex use.
func longRoot(root string) string {
	if long, err := filepath.EvalSymlinks(root); err == nil {
		return long
	}
	return root
}

// exists checks that rel names a file inside root, through os.Root.
func exists(root, rel string) bool {
	rt, err := os.OpenRoot(root)
	if err != nil {
		return false
	}
	defer rt.Close()
	fi, err := rt.Stat(rel)
	return err == nil && !fi.IsDir()
}

func hasSynctex(root, pdfRel string) bool {
	base := strings.TrimSuffix(pdfRel, filepath.Ext(pdfRel))
	return exists(root, base+".synctex.gz") || exists(root, base+".synctex")
}

// pdfFor picks the PDF a .tex file ends up in: the one named for it, else
// the newest PDF with SyncTeX data in its folder or a folder above it
// (chapters\intro.tex goes into main.pdf), up to the root.
func pdfFor(root, texRel string) string {
	same := strings.TrimSuffix(texRel, filepath.Ext(texRel)) + ".pdf"
	if exists(root, same) && hasSynctex(root, same) {
		return same
	}
	rt, err := os.OpenRoot(root)
	if err != nil {
		return ""
	}
	defer rt.Close()
	for dir := filepath.Dir(texRel); ; dir = filepath.Dir(dir) {
		var ents []os.DirEntry
		if d, err := rt.Open(dir); err == nil {
			ents, _ = d.ReadDir(-1)
			d.Close()
		}
		type cand struct {
			rel string
			mod time.Time
		}
		var cands []cand
		for _, e := range ents {
			if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".pdf") {
				continue
			}
			rel := filepath.Join(dir, e.Name())
			if fi, err := e.Info(); err == nil && hasSynctex(root, rel) {
				cands = append(cands, cand{rel, fi.ModTime()})
			}
		}
		if len(cands) > 0 {
			sort.Slice(cands, func(i, j int) bool { return cands[i].mod.After(cands[j].mod) })
			return cands[0].rel
		}
		if dir == "." || dir == string(filepath.Separator) {
			return ""
		}
	}
}

// recordedName finds how pdflatex wrote texAbs into the PDF's SyncTeX
// file ("Input:<n>:<path>" lines), or returns texAbs when it cannot tell.
func recordedName(root, pdfRel, texAbs string) string {
	rt, err := os.OpenRoot(root)
	if err != nil {
		return texAbs
	}
	defer rt.Close()
	base := strings.TrimSuffix(pdfRel, filepath.Ext(pdfRel))
	var r io.Reader
	if f, err := rt.Open(base + ".synctex.gz"); err == nil {
		defer f.Close()
		if zr, err := gzip.NewReader(f); err == nil {
			r = zr
		}
	} else if f, err := rt.Open(base + ".synctex"); err == nil {
		defer f.Close()
		r = f
	}
	if r == nil {
		return texAbs
	}
	want := canonical(texAbs)
	sc := bufio.NewScanner(r)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "Input:") {
			continue
		}
		_, p, ok := strings.Cut(strings.TrimPrefix(line, "Input:"), ":")
		if ok && canonical(p) == want {
			return p
		}
	}
	return texAbs
}

func runSynctex(ctx context.Context, dir string, args ...string) ([]byte, error) {
	bin, err := exec.LookPath("synctex")
	if err != nil {
		return nil, &httpError{status: 501, msg: "the synctex tool is not installed (it comes with MiKTeX and TeX Live)"}
	}
	ctx, cancel := context.WithTimeout(ctx, synctexTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	return cmd.Output()
}

// fields reads synctex's "Key:value" lines, one record per "Output:" (view)
// or the single result (edit).
func records(out []byte) []map[string]string {
	var recs []map[string]string
	var cur map[string]string
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		if k == "Output" || cur == nil {
			cur = map[string]string{}
			recs = append(recs, cur)
		}
		if _, dup := cur[k]; !dup {
			cur[k] = v
		}
	}
	return recs
}

func num(s string) float64 { f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); return f }

func (s *Server) syncView(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	root, err := s.fileRoot(q.Get("root"))
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	tex, err := relPath(q.Get("tex"))
	if err == nil && !exists(root, tex) {
		err = &httpError{status: 404, msg: "no such .tex file"}
	}
	line, lerr := strconv.Atoi(q.Get("line"))
	if err == nil && (lerr != nil || line < 1) {
		err = badPath("bad line")
	}
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	pdf := ""
	if q.Get("pdf") != "" {
		if pdf, err = relPath(q.Get("pdf")); err != nil {
			s.reply(w, http.StatusOK)(nil, err)
			return
		}
	} else {
		pdf = pdfFor(root, tex)
	}
	if pdf == "" || !hasSynctex(root, pdf) {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 404, msg: "no SyncTeX data: compile with -synctex=1"})
		return
	}
	long := longRoot(root)
	name := recordedName(root, pdf, filepath.Join(long, tex))
	out, err := runSynctex(r.Context(), long, "view", "-i", strconv.Itoa(line)+":0:"+name, "-o", filepath.Join(long, pdf))
	if err != nil && out == nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	var boxes []syncBox
	for _, rec := range records(out) {
		page, _ := strconv.Atoi(strings.TrimSpace(rec["Page"]))
		if page < 1 {
			continue
		}
		// h is the left edge and v the baseline; H the height above it.
		boxes = append(boxes, syncBox{Page: page, X: num(rec["h"]), Y: num(rec["v"]) - num(rec["H"]), W: num(rec["W"]), H: num(rec["H"])})
	}
	if len(boxes) == 0 {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 404, msg: "SyncTeX has no spot for that line"})
		return
	}
	writeJSON(w, struct {
		PDF   string    `json:"pdf"`
		Boxes []syncBox `json:"boxes"`
	}{filepath.ToSlash(pdf), boxes})
}

func (s *Server) syncEdit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	root, err := s.fileRoot(q.Get("root"))
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	pdf, err := relPath(q.Get("pdf"))
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	page, perr := strconv.Atoi(q.Get("page"))
	x, xerr := strconv.ParseFloat(q.Get("x"), 64)
	y, yerr := strconv.ParseFloat(q.Get("y"), 64)
	if perr != nil || xerr != nil || yerr != nil || page < 1 || x < 0 || y < 0 {
		s.reply(w, http.StatusOK)(nil, badPath("bad position"))
		return
	}
	if !exists(root, pdf) || !hasSynctex(root, pdf) {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 404, msg: "no SyncTeX data: compile with -synctex=1"})
		return
	}
	long := longRoot(root)
	spot := strconv.Itoa(page) + ":" + strconv.FormatFloat(x, 'f', 2, 64) + ":" + strconv.FormatFloat(y, 'f', 2, 64) + ":" + filepath.Join(long, pdf)
	out, err := runSynctex(r.Context(), long, "edit", "-o", spot)
	if err != nil && out == nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	for _, rec := range records(out) {
		in := strings.TrimSpace(rec["Input"])
		line, _ := strconv.Atoi(strings.TrimSpace(rec["Line"]))
		if in == "" || line < 1 {
			continue
		}
		res := syncLine{Line: line}
		if rel, ok := inside(long, in); ok {
			res.Path = filepath.ToSlash(rel)
		} else {
			res.Outside = true
		}
		writeJSON(w, res)
		return
	}
	s.reply(w, http.StatusOK)(nil, &httpError{status: 404, msg: "SyncTeX has no source for that spot"})
}

// inside returns abs relative to root when it lies within it. The tool
// reports the path pdflatex recorded; it may name a class or package
// elsewhere, which the browser is never told the path of.
func inside(root, abs string) (string, bool) {
	rel, err := filepath.Rel(canonicalOrSelf(root), canonicalOrSelf(abs))
	if err != nil || !filepath.IsLocal(rel) {
		return "", false
	}
	if _, err := relPath(rel); err != nil {
		return "", false
	}
	return rel, true
}

// canonicalOrSelf is canonical() without case folding, for filepath.Rel.
func canonicalOrSelf(p string) string {
	if long, err := filepath.EvalSymlinks(p); err == nil {
		p = long
	}
	return filepath.Clean(p)
}
