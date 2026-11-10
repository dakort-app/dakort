package server

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

// What is inside a zip, tar, tar.gz or gz file, as a list for the file
// view; nothing is unpacked to disk. A zip's directory is read from its
// end without touching the contents. A tar has no directory, so it is read
// through, up to caps on entries and bytes, so a huge or hostile archive
// (a "zip bomb") cannot keep the server busy. A lone .gz holds one file,
// named in its header, with its size in the last four bytes.
//
//	GET /api/files/archive?root=R&path=P   {entries: [{name, size, dir, mtime}], truncated}

const (
	maxEntries  = 10_000
	maxTarBytes = 1 << 30 // read through a tar to list it, decompressed
)

type archiveEntry struct {
	Name  string    `json:"name"`
	Size  int64     `json:"size"`
	Dir   bool      `json:"dir,omitempty"`
	MTime time.Time `json:"mtime,omitzero"`
}

type archiveList struct {
	Entries   []archiveEntry `json:"entries"`
	Truncated bool           `json:"truncated,omitempty"`
}

// archiveKind names the format by the file's name: zip, tar, tgz or gz.
func archiveKind(p string) string {
	lower := strings.ToLower(p)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		return "zip"
	case strings.HasSuffix(lower, ".tar"):
		return "tar"
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		return "tgz"
	case strings.HasSuffix(lower, ".gz"):
		return "gz"
	}
	return ""
}

func (s *Server) archiveFile(w http.ResponseWriter, r *http.Request) {
	f, p, err := s.open(r)
	if err != nil {
		s.reply(w, http.StatusOK)(nil, err)
		return
	}
	defer f.Close()
	kind := archiveKind(p)
	if kind == "" {
		s.reply(w, http.StatusOK)(nil, badPath("not an archive (zip, tar, tar.gz or gz)"))
		return
	}
	list, err := listArchive(f, kind, path.Base(p))
	if err != nil {
		s.reply(w, http.StatusOK)(nil, &httpError{status: 422, msg: "cannot read the archive: " + err.Error()})
		return
	}
	writeJSON(w, list)
}

func listArchive(f *os.File, kind, name string) (archiveList, error) {
	out := archiveList{Entries: []archiveEntry{}}
	switch kind {
	case "zip":
		fi, err := f.Stat()
		if err != nil {
			return out, err
		}
		zr, err := zip.NewReader(f, fi.Size())
		if err != nil {
			return out, err
		}
		for _, e := range zr.File {
			if len(out.Entries) == maxEntries {
				out.Truncated = true
				break
			}
			dir := strings.HasSuffix(e.Name, "/")
			out.Entries = append(out.Entries, archiveEntry{Name: strings.TrimSuffix(e.Name, "/"), Size: int64(e.UncompressedSize64), Dir: dir, MTime: e.Modified})
		}
	case "tar", "tgz":
		var src io.Reader = f
		if kind == "tgz" {
			gz, err := gzip.NewReader(f)
			if err != nil {
				return out, err
			}
			defer gz.Close()
			src = gz
		}
		lim := &io.LimitedReader{R: src, N: maxTarBytes}
		tr := tar.NewReader(lim)
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				if lim.N <= 0 {
					out.Truncated = true
					break
				}
				if len(out.Entries) > 0 && (errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, tar.ErrHeader)) {
					out.Truncated = true // a cut-off archive: what came before stands
					break
				}
				return out, err
			}
			if len(out.Entries) == maxEntries {
				out.Truncated = true
				break
			}
			switch h.Typeflag {
			case tar.TypeXGlobalHeader, tar.TypeXHeader, tar.TypeGNULongName, tar.TypeGNULongLink:
				continue
			}
			dir := h.Typeflag == tar.TypeDir
			n := strings.TrimSuffix(strings.TrimPrefix(h.Name, "./"), "/")
			if n == "" || n == "." {
				continue
			}
			out.Entries = append(out.Entries, archiveEntry{Name: n, Size: h.Size, Dir: dir, MTime: h.ModTime})
		}
	case "gz":
		gz, err := gzip.NewReader(f)
		if err != nil {
			return out, err
		}
		gz.Close()
		inner := gz.Name
		if inner == "" {
			inner = strings.TrimSuffix(strings.TrimSuffix(name, ".gz"), ".GZ")
		}
		// ISIZE: the size modulo 4 GiB, so right for anything smaller.
		var size int64 = -1
		if fi, err := f.Stat(); err == nil && fi.Size() >= 18 {
			var b [4]byte
			if _, err := f.ReadAt(b[:], fi.Size()-4); err == nil {
				size = int64(binary.LittleEndian.Uint32(b[:]))
			}
		}
		out.Entries = append(out.Entries, archiveEntry{Name: inner, Size: size, MTime: gz.ModTime})
	}
	return out, nil
}
