// Package server is the HTTP side: login, the session list, transcript
// pages, assets, turns, the event stream, and the embedded UI.
//
// Routes (all but /login need the session cookie):
//
//	GET  /login?token=T                        sets the cookie, redirects to /
//	GET  /api/sessions                         the index, newest activity first
//	GET  /api/folders                          every folder with sessions, and whether it is open (folders.go)
//	POST /api/folders/open                     {path}
//	POST /api/folders/close                    {path}
//	POST /api/folders/rename                   {path, name}: rename it, its sessions follow (move.go)
//	GET  /api/folders/moves                    the renames whose old folder is gone, for the page's own records
//	GET  /api/tabs?folder=F                    the folder's open tabs, shared by every device (tabs.go)
//	POST /api/tabs                             {folder, ids}: replace them
//	GET  /api/browse?path=P                    the folders inside P (home when omitted), for opening a new one
//	POST /api/browse/mkdir                     {path, name}: make a new folder there to open
//	GET  /api/files/list|raw|stat?root=R&path=P  a known folder's files (files.go)
//	POST /api/files/save?root=R&path=P          {text, base}: write an edited text file (save.go)
//	POST /api/sessions                        start a new session: {promptId, cwd, text, images, model, permissionMode}
//	GET  /api/sessions/{id}/rows               ?before=OFF&n=N  older page (OFF omitted: the newest rows)
//	                                           ?after=OFF       everything appended since OFF
//	POST /api/sessions/{id}/send               a turn: {promptId, text, images, model, permissionMode, force, queue}
//	POST /api/sessions/{id}/seen               {updated}: read up to there, on every device (seen.go)
//	POST /api/sessions/{id}/permissions/{req}  {allow, message}
//	POST /api/sessions/{id}/interrupt          stops the turn; answers {queued}: the queue, taken back (queue.go)
//	POST /api/sessions/{id}/unqueue/{promptId} a queued message taken back (queue.go)
//	POST /api/sessions/{id}/leftovers/{pid}/stop ends a process a turn left running (leftovers.go)
//	POST /api/sessions/{id}/settings           {idleCompact, effort, ultracode, chrome}: kept at once (compact.go)
//	POST /api/sessions/{id}/rename             {title}: name it, through the CLI's /rename (compact.go)
//	GET  /api/events?last=ID                   the event stream (Server-Sent Events)
//	GET  /api/assets/{name}                    an image or PDF a row refers to
//	POST /api/restart                          restart for a new build once no turn runs (restart.go)
//	GET  /api/commands?folder=F                the slash commands the composer offers (commands.go)
//	GET  /                                     the UI
//
// Every action is a POST whose response is its acknowledgement; the stream
// carries everything else. See hub.go for the events.
package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dakort-app/dakort/internal/claude"
	"github.com/dakort-app/dakort/internal/codex"
	"github.com/dakort-app/dakort/internal/index"
	"github.com/dakort-app/dakort/internal/transcript"
)

//go:embed ui
var uiFiles embed.FS

// Rows per page when the client does not say; capped so a phone never
// pulls a large session in one request.
const (
	defaultRows = 50
	maxRows     = 500
)

const (
	// minRefresh throttles index refreshes driven by requests.
	minRefresh = 2 * time.Second
	// pollEvery is the index poll while a browser is connected.
	pollEvery = 2500 * time.Millisecond
	// pingEvery keeps the stream alive and lets the browser notice a
	// dead one (it reconnects after about 40 s of silence).
	pingEvery = 15 * time.Second
	// maxBody covers a prompt with a few pasted images in base64.
	maxBody = 48 << 20
)

type Config struct {
	Token      string
	Index      *index.Index
	Assets     transcript.Dir
	ClaudeBin  string        // found on PATH or in ~/.local/bin when empty
	CodexBin   string        // found on PATH (the npm script's real program) when empty
	CLIEnv     []string      // added to a sign-in command's environment; tests point the CLIs' config folders elsewhere
	MaxTurns   int           // concurrent CLI processes; 3 when zero
	Folders    string        // the open-folder list's file; in memory only when empty
	Moves      string        // the folder renames (move.go); in memory only when empty
	Seen       string        // how far each session has been read (seen.go); in memory only when empty
	Tabs       string        // each folder's open tabs (tabs.go); in memory only when empty
	Password   string        // the password hash's file; no password login when empty
	Trash      string        // where deleted sessions go; deleting is off when empty
	Settings   string        // per-session model, effort, mode, Ultracode; memory only when empty
	PingEvery  time.Duration // pingEvery when zero
	Restart    func()        // called once no turn runs after POST /api/restart; that route is off when nil
	Compact    CompactConfig // idle compaction (compact.go); off unless On
	Release    ReleaseConfig // the notice of a newer release (release.go); off unless On
	WarmModels bool          // ask the CLIs for their model lists at start, for the picker
	Version    string        // the build, told to every page in its snapshot (a page from an older build reloads itself)
}

type Server struct {
	token  string
	idx    *index.Index
	assets transcript.Dir
	hub    *hub
	runner *runner
	store  *folderStore
	moves  *moveStore
	moveMu sync.Mutex // one folder rename at a time
	seen   *seenStore
	tabs   *tabStore
	pw     *passwords
	trash  string
	ping   time.Duration

	refreshMu   sync.Mutex
	lastRefresh time.Time

	restart     func()
	restartOnce sync.Once

	cmds    commandCache // the "/" menu per folder (commands.go)
	claude  claudeCache  // the Claude model list (claudeinfo.go)
	codex   codexCache   // the Codex model list (codexinfo.go)
	signins signIns      // sign-ins run from the page (signin.go)

	autoUpdate bool // newer releases are installed by this server itself (release.go); told to the page

	stop      chan struct{}
	done      sync.WaitGroup
	closeOnce sync.Once
}

func New(c Config) *Server {
	if c.ClaudeBin == "" {
		c.ClaudeBin, _ = claude.FindBinary() // sends fail with a clear error if empty
	}
	if c.CodexBin == "" {
		c.CodexBin, _ = codex.FindBinary()
	}
	if c.MaxTurns == 0 {
		c.MaxTurns = 3
	}
	if c.PingEvery == 0 {
		c.PingEvery = pingEvery
	}
	s := &Server{token: c.Token,
		idx: c.Index, assets: c.Assets, hub: newHub(), stop: make(chan struct{}),
		store: loadFolders(c.Folders), moves: loadMoves(c.Moves), seen: loadSeen(c.Seen), tabs: loadTabs(c.Tabs), ping: c.PingEvery, pw: &passwords{file: c.Password}, trash: c.Trash, restart: c.Restart}
	s.hub.build = c.Version
	s.signins.env = c.CLIEnv
	s.autoUpdate = c.Release.On && c.Release.Auto && c.Release.Update != nil && autoUpdates(c.Version)
	emptyTrash(c.Trash)
	if c.Index != nil {
		c.Index.SetMoved(s.moves.apply)
	}
	s.runner = newRunner(s.hub, c.Index, c.ClaudeBin, c.CodexBin, c.MaxTurns, func() { s.refresh(true) })
	// The model lists take a few seconds to ask for; have them ready
	// before the first page asks (GET /api/config). Not in tests: each
	// would start two CLIs for nothing.
	if c.WarmModels {
		go func() {
			s.claudeInfo(context.Background())
			s.codexInfo(context.Background())
		}()
	}
	s.runner.loadSettings(c.Settings)
	s.done.Add(1)
	go s.poll()
	if c.Compact.On {
		s.done.Add(1)
		go s.compactLoop(c.Compact.withDefaults())
	}
	if c.Release.On {
		s.done.Add(1)
		go s.releaseLoop(c.Release.withDefaults())
	}
	return s
}

// Close stops the poll and closes running turns' processes. Safe to call
// more than once.
func (s *Server) Close() {
	s.closeOnce.Do(func() {
		close(s.stop)
		s.runner.stop()
		s.signins.stopAll()
		s.done.Wait()
	})
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /login", s.login)
	mux.HandleFunc("POST /api/login", s.passwordLogin)
	mux.HandleFunc("POST /api/setup", s.passwordSetup)
	mux.HandleFunc("GET /api/sessions", s.sessions)
	mux.HandleFunc("GET /api/folders", s.folders)
	mux.HandleFunc("POST /api/folders/open", s.openFolder)
	mux.HandleFunc("POST /api/folders/close", s.closeFolder)
	mux.HandleFunc("POST /api/folders/rename", s.renameFolder)
	mux.HandleFunc("GET /api/folders/moves", s.listMoves)
	mux.HandleFunc("GET /api/tabs", s.getTabs)
	mux.HandleFunc("POST /api/tabs", s.setTabs)
	mux.HandleFunc("GET /api/browse", s.browse)
	mux.HandleFunc("POST /api/browse/mkdir", s.mkdir)
	mux.HandleFunc("GET /api/files/list", s.listFiles)
	mux.HandleFunc("GET /api/files/raw", s.rawFile)
	mux.HandleFunc("GET /api/files/stat", s.statFile)
	mux.HandleFunc("POST /api/files/open", s.openLocal)
	mux.HandleFunc("POST /api/files/save", s.saveFile)
	mux.HandleFunc("GET /api/here", s.here)
	mux.HandleFunc("GET /api/files/archive", s.archiveFile)
	mux.HandleFunc("GET /api/files/synctex/view", s.syncView)
	mux.HandleFunc("GET /api/files/synctex/edit", s.syncEdit)
	mux.HandleFunc("POST /api/sessions", s.newSession)
	mux.HandleFunc("GET /api/sessions/{id}/rows", s.rows)
	mux.HandleFunc("POST /api/sessions/{id}/send", s.send)
	mux.HandleFunc("POST /api/sessions/{id}/seen", s.markSeen)
	mux.HandleFunc("POST /api/sessions/{id}/permissions/{req}", s.permission)
	mux.HandleFunc("POST /api/sessions/{id}/interrupt", s.interrupt)
	mux.HandleFunc("POST /api/sessions/{id}/unqueue/{promptId}", s.unqueue)
	mux.HandleFunc("POST /api/sessions/{id}/tasks/{task}/stop", s.stopTask)
	mux.HandleFunc("POST /api/sessions/{id}/leftovers/{pid}/stop", s.stopLeftoverHandler)
	mux.HandleFunc("POST /api/sessions/{id}/delete", s.deleteSession)
	mux.HandleFunc("POST /api/sessions/{id}/settings", s.sessionSettings)
	mux.HandleFunc("POST /api/sessions/{id}/rename", s.rename)
	mux.HandleFunc("POST /api/trash/{name}/restore", s.restoreSession)
	mux.HandleFunc("GET /api/config", s.config)
	mux.HandleFunc("POST /api/signin", s.signInStart)
	mux.HandleFunc("GET /api/signin", s.signInStatus)
	mux.HandleFunc("POST /api/signin/code", s.signInCode)
	mux.HandleFunc("POST /api/signin/cancel", s.signInCancel)
	mux.HandleFunc("GET /api/commands", s.commands)
	mux.HandleFunc("POST /api/restart", s.restartWhenIdle)
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("GET /api/assets/{name}", s.asset)
	ui, _ := fs.Sub(uiFiles, "ui")
	mux.Handle("GET /", cachedUI(ui))
	return s.auth(mux)
}

// uiTypes are the content types of the UI's files, fixed here: on Windows
// the standard table can be overridden from the registry, which on some
// machines maps .js to text/plain and breaks module scripts.
var uiTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
	".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
}

type uiFile struct {
	data, gz []byte // gz is nil when compressing does not pay
	etag     string
	ctype    string
}

// cachedUI serves the embedded UI from memory, gzipped where that helps
// (the pdf.js worker shrinks from 1.3 MB), with an ETag per file. Embedded
// files have no modification time, so without one a phone refetches the
// whole app on every load; with it a reload is a 304.
func cachedUI(ui fs.FS) http.Handler {
	files := map[string]*uiFile{}
	fs.WalkDir(ui, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		data, err := fs.ReadFile(ui, p)
		if err != nil {
			return nil
		}
		sum := sha256.Sum256(data)
		f := &uiFile{data: data, etag: `"` + hex.EncodeToString(sum[:16]) + `"`, ctype: uiTypes[strings.ToLower(path.Ext(p))]}
		if f.ctype == "" {
			f.ctype = "application/octet-stream"
		}
		if len(data) > 1024 && !strings.HasPrefix(f.ctype, "font/woff") && !strings.HasPrefix(f.ctype, "image/png") {
			var b bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&b, gzip.BestCompression)
			zw.Write(data)
			zw.Close()
			if b.Len() < len(data)*9/10 {
				f.gz = b.Bytes()
			}
		}
		files["/"+p] = f
		return nil
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Path
		if strings.HasSuffix(name, "/") {
			name += "index.html"
		}
		f, ok := files[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("ETag", f.etag)
		h.Set("Cache-Control", "no-cache") // keep it, but ask each time
		h.Set("Vary", "Accept-Encoding")
		h.Set("Content-Type", f.ctype)
		h.Set("X-Content-Type-Options", "nosniff")
		if r.Header.Get("If-None-Match") == f.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		body := f.data
		if f.gz != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			body = f.gz
			h.Set("Content-Encoding", "gzip")
		}
		h.Set("Content-Length", strconv.Itoa(len(body)))
		w.Write(body)
	})
}

// poll refreshes the index while anyone watches the stream; nobody needs
// a fresh list when nobody is looking.
func (s *Server) poll() {
	defer s.done.Done()
	tick := time.NewTicker(pollEvery)
	defer tick.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-tick.C:
			if s.hub.watched() {
				s.refresh(true)
			}
			s.runner.pollLeftovers() // cheap: one call per session with any
		}
	}
}

// refresh updates the index, at most every minRefresh unless forced, and
// tells viewers when the list changed. A session that grew without a turn
// of ours (another Claude is writing it) gets an "appended" with no UUID,
// so an open transcript catches up; ours announce their own rows.
func (s *Server) refresh(force bool) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	if !force && time.Since(s.lastRefresh) < minRefresh {
		return
	}
	before := map[string]int64{}
	for _, sess := range s.idx.List() {
		before[sess.ID] = sess.Size
	}
	changed, err := s.idx.Refresh()
	if err != nil {
		log.Printf("index refresh: %v", err)
	}
	s.lastRefresh = time.Now()
	if changed {
		s.hub.publish(Ev{Type: "sessions"})
		for _, sess := range s.idx.List() {
			if size, ok := before[sess.ID]; ok && sess.Size > size && !s.runner.running(sess.ID) {
				s.hub.publish(Ev{Type: "appended", Session: sess.ID})
			}
		}
	}
}

// sessionView adds what only the server knows to an index entry.
type sessionView struct {
	index.Session
	// Folder is the cwd as the folder list spells it, so the UI can group
	// by it without knowing that Windows paths ignore case.
	Folder  string `json:"folder,omitempty"`
	Running bool   `json:"running,omitempty"`
	// Remembered from this server run's sends; empty means the CLI's default.
	Model          string `json:"model,omitempty"`
	Effort         string `json:"effort,omitempty"`
	PermissionMode string `json:"permissionMode,omitempty"`
	Ultracode      bool   `json:"ultracode,omitempty"`
	Chrome         bool   `json:"chrome,omitempty"` // Claude in Chrome on for its turns
	IdleCompact    bool   `json:"idleCompact"`      // compact when idle (compact.go); on unless switched off
	// Seen: read up to this updated time, on any device (seen.go). The
	// session is unread when Updated is later.
	Seen time.Time `json:"seen"`
}

func (s *Server) sessions(w http.ResponseWriter, r *http.Request) {
	s.refresh(false)
	ours := s.runner.ourPIDs()
	list := s.idx.List()
	paths := folderPaths(list)
	out := make([]sessionView, len(list))
	for i, sess := range list {
		if ours[sess.HeldBy] {
			sess.HeldBy = 0 // our own CLI; not a warning
		}
		st := s.runner.settingsOf(sess.ID)
		out[i] = sessionView{Session: sess, Running: s.runner.running(sess.ID),
			Model: st.model, Effort: st.effort, PermissionMode: st.permissionMode, Ultracode: st.ultracode, Chrome: st.chrome,
			IdleCompact: !st.noIdleCompact, Seen: s.seen.get(sess.ID)}
		if sess.Cwd != "" {
			out[i].Folder = paths[folderKey(sess.Cwd)]
		}
	}
	writeJSON(w, out)
}

type rowsPage struct {
	Rows []transcript.Row `json:"rows"`
	// AtStart: no older rows exist (Tail pages only).
	AtStart bool `json:"atStart,omitempty"`
	// Next is the offset to pass as after= to catch up later.
	Next int64 `json:"next"`
}

func (s *Server) rows(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.idx.Get(r.PathValue("id"))
	if !ok {
		s.refresh(true) // a session started since the last poll
		if sess, ok = s.idx.Get(r.PathValue("id")); !ok {
			http.Error(w, "no such session", http.StatusNotFound)
			return
		}
	}
	reader := &transcript.Reader{Path: sess.Path, Assets: s.assets, Format: sess.Provider}
	q := r.URL.Query()
	var page rowsPage
	var err error
	if q.Has("after") {
		off, perr := strconv.ParseInt(q.Get("after"), 10, 64)
		if perr != nil {
			http.Error(w, "bad after", http.StatusBadRequest)
			return
		}
		page.Rows, page.Next, err = reader.After(off)
	} else {
		before := int64(-1)
		if q.Has("before") {
			if before, err = strconv.ParseInt(q.Get("before"), 10, 64); err != nil || before < 0 {
				http.Error(w, "bad before", http.StatusBadRequest)
				return
			}
		}
		n := defaultRows
		if q.Has("n") {
			if n, err = strconv.Atoi(q.Get("n")); err != nil || n < 1 {
				http.Error(w, "bad n", http.StatusBadRequest)
				return
			}
		}
		page.Rows, page.AtStart, err = reader.Tail(before, min(n, maxRows))
		if len(page.Rows) > 0 {
			// Catching up from the end of the last row rereads the
			// bookkeeping lines after it, which are not rows; harmless.
			page.Next = page.Rows[len(page.Rows)-1].End
		} else if before >= 0 {
			page.Next = before
		}
	}
	switch {
	case errors.Is(err, transcript.ErrOffset):
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	case errors.Is(err, os.ErrNotExist):
		http.Error(w, "session file is gone", http.StatusNotFound)
		return
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if page.Rows == nil {
		page.Rows = []transcript.Row{}
	}
	writeJSON(w, page)
}

func (s *Server) newSession(w http.ResponseWriter, r *http.Request) {
	var req sendRequest
	if !readJSON(w, r, &req) {
		return
	}
	s.reply(w, http.StatusAccepted)(s.runner.send("", req))
}

func (s *Server) send(w http.ResponseWriter, r *http.Request) {
	var req sendRequest
	if !readJSON(w, r, &req) {
		return
	}
	s.reply(w, http.StatusAccepted)(s.queueOrSend(r.PathValue("id"), req))
}

func (s *Server) permission(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Allow   bool   `json:"allow"`
		Message string `json:"message"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	err := s.runner.answer(r.PathValue("id"), r.PathValue("req"), req.Allow, req.Message)
	s.reply(w, http.StatusOK)(struct{}{}, err)
}

func (s *Server) interrupt(w http.ResponseWriter, r *http.Request) {
	if !readJSON(w, r, &struct{}{}) {
		return
	}
	// The queue first, so the turn's end does not send the next message.
	// Taken back even if no turn was running, so the box gets it.
	back := s.runner.takeBack(r.PathValue("id"), "")
	err := s.runner.interrupt(r.PathValue("id"))
	if len(back) > 0 {
		err = nil
	}
	s.reply(w, http.StatusOK)(struct {
		Queued []TakenBack `json:"queued"`
	}{back}, err)
}

// stopTask stops one background task. The model is not told; it finds out
// when next asked.
func (s *Server) stopTask(w http.ResponseWriter, r *http.Request) {
	if !readJSON(w, r, &struct{}{}) {
		return
	}
	s.reply(w, http.StatusOK)(struct{}{}, s.runner.stopTask(r.PathValue("id"), r.PathValue("task")))
}

// reply writes v with status ok, or the error as JSON.
func (s *Server) reply(w http.ResponseWriter, ok int) func(any, error) {
	return func(v any, err error) {
		if err != nil {
			he := asHTTPError(err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(he.status)
			json.NewEncoder(w).Encode(struct {
				Error     string        `json:"error"`
				HeldBy    int           `json:"heldBy,omitempty"`
				Leftovers []leftoverRef `json:"leftovers,omitempty"`
			}{he.msg, he.heldBy, he.left})
			return
		}
		if rep, isSend := v.(sendReply); isSend && rep.Duplicate {
			ok = http.StatusOK // already accepted earlier
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(ok)
		json.NewEncoder(w).Encode(v)
	}
}

// readJSON decodes a POST body. Requiring a JSON content type also keeps
// other sites from posting here with a plain form (the browser would have
// to ask first, and the server never says yes).
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		http.Error(w, "send application/json", http.StatusUnsupportedMediaType)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, "bad JSON: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

// events is the Server-Sent Events stream. The browser passes the last
// event id it saw (the Last-Event-ID header on its own reconnects, the last
// query parameter when the page recreates the stream) and gets the events
// after it, or a snapshot when they are gone.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	last := r.URL.Query().Get("last")
	if h := r.Header.Get("Last-Event-ID"); h != "" {
		last = h
	}
	rc := http.NewResponseController(w)
	rc.SetWriteDeadline(time.Time{}) // the stream stays open
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	sub, replay, snap := s.hub.subscribe(last)
	defer s.hub.unsubscribe(sub)
	write := func(e event) bool {
		_, err := w.Write([]byte("id: " + e.id + "\ndata: " + string(e.data) + "\n\n"))
		return err == nil
	}
	// Tell the browser how long to wait before its own reconnects.
	w.Write([]byte("retry: 2000\n\n"))
	if snap != nil {
		write(*snap)
	}
	for _, e := range replay {
		write(e)
	}
	if rc.Flush() != nil {
		return
	}
	ping := time.NewTicker(s.ping)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.stop:
			return
		case <-ping.C:
			// A data event, since EventSource never surfaces comments and
			// the browser's watchdog must see it. No id line: the browser's
			// last id, its replay cursor, stays as it was.
			w.Write([]byte(`data: {"type":"ping"}` + "\n\n"))
		case e, ok := <-sub.ch:
			if !ok {
				return // fell behind; the browser reconnects and replays
			}
			if !write(e) {
				return
			}
			// Send whatever else is already queued in the same flush.
			for more := true; more; {
				select {
				case e, ok := <-sub.ch:
					if !ok {
						rc.Flush()
						return
					}
					write(e)
				default:
					more = false
				}
			}
		}
		if rc.Flush() != nil {
			return
		}
	}
}

// Asset names are content hashes the reader made, so only that shape is
// served and no request can name a path.
var assetName = regexp.MustCompile(`^[0-9a-f]{64}\.(png|jpg|gif|webp|pdf|bin)$`)

func (s *Server) asset(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !assetName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	// Named by content, so a name never changes meaning.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, filepath.Join(string(s.assets), name))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// A tab that went away mid-reply (every restart cuts a few off) is
		// not worth a line; a value that cannot be encoded is.
		var ne *net.OpError
		if !errors.As(err, &ne) {
			log.Printf("write response: %v", err)
		}
	}
}
