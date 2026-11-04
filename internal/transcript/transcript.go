// Package transcript reads Claude Code's session files
// (~/.claude/projects/<project>/<session>.jsonl) into display rows.
//
// The file is the database. Every row carries the byte offsets of its line,
// and the two readers page by offset: Tail for the newest rows and for
// scrolling up, After to catch up on everything appended since an offset.
// Image and document blocks go to an asset store and are referenced by
// name, so a row never carries base64.
//
// Rows are the lines of type user, assistant or system that carry a uuid,
// in file order. Nothing else in the file is a row: the CLI also writes
// request caches (api-request-blob, with a message but no uuid), queue
// operations, titles, file snapshots and more, and the list grows with
// versions. A survey of every transcript on this laptop (2026-10-21) found
// no edited prompts, so there is no branch logic.
package transcript

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Role string

const (
	User      Role = "user"
	Assistant Role = "assistant"
	System    Role = "system" // compaction boundaries, API errors, notices
)

type Row struct {
	UUID   string    `json:"uuid"`
	Parent string    `json:"parent,omitempty"`
	Role   Role      `json:"role"`
	Time   time.Time `json:"time"`
	Offset int64     `json:"offset"` // where the line starts in the file
	End    int64     `json:"end"`    // just past its newline; the next line starts here

	// User rows: the permission mode the CLI ran with. With the model on
	// assistant rows, it says what the session last used, from any client.
	PermissionMode string `json:"permissionMode,omitempty"`

	Meta           bool `json:"meta,omitempty"`           // CLI bookkeeping sent to the model, not typed by the person
	CompactSummary bool `json:"compactSummary,omitempty"` // the summary that opens a compacted session
	Sidechain      bool `json:"sidechain,omitempty"`      // subagent row (older CLIs kept them inline)

	// Assistant rows. The blocks of one API message land as separate rows
	// that share MessageID.
	MessageID  string `json:"messageId,omitempty"`
	Model      string `json:"model,omitempty"`
	StopReason string `json:"stopReason,omitempty"`
	APIError   bool   `json:"apiError,omitempty"` // a synthetic assistant row holding an API error
	// Context is the prompt size of the API call that wrote the row (input
	// plus cache read plus cache creation): the session's context as of
	// that call. The result event's usage is summed over a turn's calls,
	// so it cannot stand in for this.
	Context int `json:"context,omitempty"`
	// CacheTTL is the prompt cache the call wrote to, "1h" or "5m"; empty
	// when it wrote none (all read) or the CLI did not say.
	CacheTTL string `json:"cacheTtl,omitempty"`
	// Window is the model's context window in tokens, where the transcript
	// says (Codex's task_started; Claude's transcripts do not).
	Window int `json:"window,omitempty"`

	// System rows.
	Subtype string `json:"subtype,omitempty"` // compact_boundary, api_error, informational, local_command, ...
	Level   string `json:"level,omitempty"`
	Content string `json:"content,omitempty"`
	// compact_boundary rows: the context before and (when the CLI records
	// it) after the compaction.
	PreTokens  int `json:"preTokens,omitempty"`
	PostTokens int `json:"postTokens,omitempty"`

	Blocks []Block `json:"blocks,omitempty"`
}

// Block is one content block. Types seen: text, thinking, tool_use,
// tool_result, image, document, tool_reference. Unknown types keep their
// name and text so the UI can show something.
type Block struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"` // text; thinking (empty when the CLI redacts it)

	ID    string          `json:"id,omitempty"`    // tool_use id; on a tool_result, the tool_use it answers
	Name  string          `json:"name,omitempty"`  // tool name
	Input json.RawMessage `json:"input,omitempty"` // tool_use input

	IsError bool    `json:"isError,omitempty"`
	Content []Block `json:"content,omitempty"` // tool_result parts: text, image, document

	MediaType string `json:"mediaType,omitempty"` // image, document
	Asset     string `json:"asset,omitempty"`     // name in the asset store; empty when no store was given
	Size      int    `json:"size,omitempty"`      // decoded bytes
}

// Assets stores binary blocks (images, PDFs) outside the rows.
type Assets interface {
	// Put stores data and returns the name a row refers to it by. Storing
	// the same bytes twice returns the same name.
	Put(mediaType string, data []byte) (string, error)
}

// Dir is an Assets that writes each blob once, named by its content hash,
// into a folder.
type Dir string

func (d Dir) Put(mediaType string, data []byte) (string, error) {
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:]) + assetExt(mediaType)
	path := filepath.Join(string(d), name)
	if _, err := os.Stat(path); err == nil {
		return name, nil
	}
	if err := os.MkdirAll(string(d), 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(string(d), name+".*.tmp")
	if err != nil {
		return "", err
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp.Name())
		return "", errors.Join(werr, cerr)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		os.Remove(tmp.Name())
		// Another reader stored the same blob first; that is fine.
		if _, serr := os.Stat(path); serr != nil {
			return "", err
		}
	}
	return name, nil
}

func assetExt(mediaType string) string {
	switch mediaType {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "application/pdf":
		return ".pdf"
	}
	return ".bin"
}

// Reader pages one session file.
type Reader struct {
	Path string
	// Assets receives image and document data. When nil the data is
	// dropped and the block keeps only its media type and size.
	Assets Assets
	// Format is the file's provider: "claude" (the default) or "codex"
	// (a rollout, see codex.go). Both page the same way.
	Format string
}

func (r *Reader) parser() parser {
	return parser{assets: r.Assets, codex: r.Format == "codex"}
}

// ErrOffset means an offset did not point at the start of a line.
var ErrOffset = errors.New("transcript: offset is not at a line start")

// tailChunk is the first slice of the file Tail reads; it doubles until
// enough rows are in hand. One image row can be 2 MB.
const tailChunk = 256 << 10

// Tail returns up to n rows that end at or before offset before (the file
// end when before is negative), oldest first. atStart reports that no row
// precedes the returned ones, so a caller paging upward can stop.
func (r *Reader) Tail(before int64, n int) (rows []Row, atStart bool, err error) {
	f, err := open(r.Path)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return nil, false, err
	}
	if before < 0 || before >= size {
		// The file end needs no check: a last line still being written
		// has no newline yet and is left out by the loop below.
		before = size
	} else if err := checkLineStart(f, before); err != nil {
		return nil, false, err
	}
	p := r.parser()
	chunk := int64(tailChunk)
	for {
		start := before - chunk
		if start < 0 {
			start = 0
		}
		buf := make([]byte, before-start)
		if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
			return nil, false, err
		}
		skip := 0
		if start > 0 {
			// The chunk starts mid-line; that line belongs to an earlier page.
			i := bytes.IndexByte(buf, '\n')
			if i < 0 {
				chunk *= 2
				continue
			}
			skip = i + 1
		}
		rows = rows[:0]
		for pos, base := 0, start+int64(skip); pos < len(buf)-skip; {
			line := buf[skip+pos:]
			nl := bytes.IndexByte(line, '\n')
			if nl < 0 {
				break
			}
			line = line[:nl]
			rows = append(rows, p.rows(line, base+int64(pos), base+int64(pos+nl+1))...)
			pos += nl + 1
		}
		if len(rows) > n {
			return rows[len(rows)-n:], false, nil
		}
		if start == 0 {
			return rows, true, nil
		}
		chunk *= 2
	}
}

// After returns the rows that start at or after offset, oldest first, and
// the offset to pass next time. A last line still being written (no
// newline yet) is left for the next call.
func (r *Reader) After(offset int64) (rows []Row, next int64, err error) {
	f, err := open(r.Path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	if err := checkLineStart(f, offset); err != nil {
		return nil, 0, err
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, 0, err
	}
	p := r.parser()
	br := bufio.NewReaderSize(f, 1<<20)
	pos := offset
	for {
		line, err := br.ReadBytes('\n')
		if err == io.EOF {
			// Partial last line, or nothing: not consumed.
			return rows, pos, nil
		}
		if err != nil {
			return rows, pos, err
		}
		end := pos + int64(len(line))
		rows = append(rows, p.rows(line[:len(line)-1], pos, end)...)
		pos = end
	}
}

// All reads every row. Fine for tests and tools; a server pages instead.
func (r *Reader) All() ([]Row, error) {
	rows, _, err := r.After(0)
	return rows, err
}

func checkLineStart(f *os.File, offset int64) error {
	if offset < 0 {
		return ErrOffset
	}
	if offset == 0 {
		return nil
	}
	var b [1]byte
	n, err := f.ReadAt(b[:], offset-1)
	if err != nil && err != io.EOF {
		return err
	}
	if n != 1 || b[0] != '\n' {
		return ErrOffset
	}
	return nil
}

// rawRow is the subset of a transcript line the reader looks at.
type rawRow struct {
	Type              string          `json:"type"`
	UUID              string          `json:"uuid"`
	ParentUUID        string          `json:"parentUuid"`
	Timestamp         time.Time       `json:"timestamp"`
	IsMeta            bool            `json:"isMeta"`
	IsCompactSummary  bool            `json:"isCompactSummary"`
	IsSidechain       bool            `json:"isSidechain"`
	IsAPIErrorMessage bool            `json:"isApiErrorMessage"`
	PermissionMode    string          `json:"permissionMode"`
	Subtype           string          `json:"subtype"`
	Level             string          `json:"level"`
	Content           json.RawMessage `json:"content"` // system rows: a string
	CompactMetadata   *struct {
		PreTokens  int `json:"preTokens"`
		PostTokens int `json:"postTokens"`
	} `json:"compactMetadata"`
	Message *struct {
		ID         string          `json:"id"`
		Model      string          `json:"model"`
		StopReason string          `json:"stop_reason"`
		Content    json.RawMessage `json:"content"` // a string or blocks
		Usage      *struct {
			Input         int `json:"input_tokens"`
			CacheRead     int `json:"cache_read_input_tokens"`
			CacheCreation int `json:"cache_creation_input_tokens"`
			ByLife        *struct {
				Hour    int `json:"ephemeral_1h_input_tokens"`
				Minutes int `json:"ephemeral_5m_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`

	// Session identity, read by Head.
	SessionID  string `json:"sessionId"`
	Cwd        string `json:"cwd"`
	Version    string `json:"version"`
	GitBranch  string `json:"gitBranch"`
	Entrypoint string `json:"entrypoint"`
}

type rawBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	ToolName  string          `json:"tool_name"` // tool_reference
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	IsError   bool            `json:"is_error"`
	Content   json.RawMessage `json:"content"` // tool_result: a string or blocks
	Source    *struct {
		Type      string `json:"type"`
		MediaType string `json:"media_type"`
		Data      string `json:"data"`
	} `json:"source"`
}

type parser struct {
	assets     Assets
	skipBinary bool // leave image data undecoded (Head only needs text)
	codex      bool // a Codex rollout (codex.go) rather than a Claude transcript
}

var uuidKey = []byte(`"uuid":`)

// rows parses one line into its rows: none for bookkeeping, one for a
// Claude row, and for a Codex item that is a call and its answer in one,
// two (sharing the line's offsets).
func (p parser) rows(line []byte, start, end int64) []Row {
	if p.codex {
		return p.codexRows(line, start, end)
	}
	if row, ok := p.row(line, start, end); ok {
		return []Row{row}
	}
	return nil
}

// row parses one line, without its newline, into a Row. ok is false for
// every line that is not a conversation row.
func (p parser) row(line []byte, start, end int64) (Row, bool) {
	if !bytes.Contains(line, uuidKey) {
		return Row{}, false
	}
	var rr rawRow
	if err := json.Unmarshal(line, &rr); err != nil || rr.UUID == "" {
		return Row{}, false
	}
	row := Row{
		UUID:           rr.UUID,
		Parent:         rr.ParentUUID,
		Time:           rr.Timestamp,
		Offset:         start,
		End:            end,
		Meta:           rr.IsMeta,
		CompactSummary: rr.IsCompactSummary,
		Sidechain:      rr.IsSidechain,
	}
	switch rr.Type {
	case "user":
		row.Role = User
		row.PermissionMode = rr.PermissionMode
	case "assistant":
		row.Role = Assistant
		row.APIError = rr.IsAPIErrorMessage
		if rr.Message != nil {
			row.MessageID, row.Model, row.StopReason = rr.Message.ID, rr.Message.Model, rr.Message.StopReason
			if u := rr.Message.Usage; u != nil {
				row.Context = u.Input + u.CacheRead + u.CacheCreation
				if b := u.ByLife; b != nil && b.Hour > 0 {
					row.CacheTTL = "1h"
				} else if b != nil && b.Minutes > 0 {
					row.CacheTTL = "5m"
				}
			}
		}
	case "system":
		row.Role = System
		row.Subtype, row.Level = rr.Subtype, rr.Level
		json.Unmarshal(rr.Content, &row.Content)
		if m := rr.CompactMetadata; m != nil {
			row.PreTokens, row.PostTokens = m.PreTokens, m.PostTokens
		}
		return row, true
	default:
		return Row{}, false
	}
	if rr.Message != nil {
		row.Blocks = p.blocks(rr.Message.Content)
	}
	return row, true
}

// blocks decodes message content, which is a plain string or a block list.
func (p parser) blocks(raw json.RawMessage) []Block {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil
		}
		return []Block{{Type: "text", Text: s}}
	}
	var rbs []rawBlock
	if json.Unmarshal(raw, &rbs) != nil {
		return nil
	}
	out := make([]Block, 0, len(rbs))
	for _, rb := range rbs {
		b := Block{Type: rb.Type}
		switch rb.Type {
		case "text":
			b.Text = rb.Text
		case "thinking", "redacted_thinking":
			b.Type, b.Text = "thinking", rb.Thinking
		case "tool_use":
			b.ID, b.Name, b.Input = rb.ID, rb.Name, rb.Input
		case "tool_result":
			b.ID, b.IsError = rb.ToolUseID, rb.IsError
			b.Content = p.blocks(rb.Content)
		case "image", "document":
			if rb.Source != nil {
				b.MediaType = rb.Source.MediaType
				if rb.Source.Type == "base64" && !p.skipBinary {
					p.store(&b, rb.Source.Data)
				}
			}
		case "tool_reference":
			b.Name = rb.ToolName
		default:
			b.Text = rb.Text
		}
		out = append(out, b)
	}
	return out
}

func (p parser) store(b *Block, b64 string) {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		data, err = base64.RawStdEncoding.DecodeString(b64)
	}
	if err != nil {
		return
	}
	b.Size = len(data)
	if p.assets == nil {
		return
	}
	if name, err := p.assets.Put(b.MediaType, data); err == nil {
		b.Asset = name
	}
}

// attachedTag matches the opening tag of context the CLI attaches to a
// prompt: <system-reminder>, <ide_selection>, <pasted_content id="..">,
// <command-name>, <task-notification> and so on.
var attachedTag = regexp.MustCompile(`^<[a-z][a-z0-9_-]*(\s[^>]*)?>`)

// PromptText is what the person typed in a user row: its plain text blocks
// joined by blank lines. Context the CLI attaches (tagged blocks), image
// placeholders, interrupt markers, tool results, meta rows and compaction
// summaries give an empty string.
func (r *Row) PromptText() string {
	if r.Role != User || r.Meta || r.CompactSummary {
		return ""
	}
	var parts []string
	for _, b := range r.Blocks {
		if b.Type != "text" {
			continue
		}
		t := strings.TrimSpace(b.Text)
		if t == "" || attachedTag.MatchString(t) ||
			strings.HasPrefix(t, "[Request interrupted by user") ||
			strings.HasPrefix(t, "[Image: source:") {
			continue
		}
		parts = append(parts, t)
	}
	return strings.Join(parts, "\n\n")
}

// Info is what the start of a file says about a session.
type Info struct {
	SessionID  string
	Cwd        string // as the CLI recorded it, with the drive letter's real case
	Version    string // CLI version that wrote the first row
	GitBranch  string
	Entrypoint string
	First      time.Time // time of the first row
	Subagent   bool      // a Codex thread started by Codex itself, not by a person

	// Title sources, each empty when not found within the scan.
	AITitle     string // the CLI's generated title
	Summary     string // older CLIs' summary row
	FirstPrompt string // the first text the person typed

	Scanned int64 // bytes read
}

// Head reads the start of a session file for its identity and title
// sources. It stops once a prompt and an AI title are both in hand, or
// after maxBytes.
func Head(path string, maxBytes int64) (Info, error) {
	f, err := open(path)
	if err != nil {
		return Info{}, err
	}
	defer f.Close()
	var info Info
	p := parser{skipBinary: true}
	br := bufio.NewReaderSize(f, 1<<20)
	for info.Scanned < maxBytes {
		line, err := br.ReadBytes('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			return info, err
		}
		info.Scanned += int64(len(line))
		switch {
		case info.AITitle == "" && bytes.Contains(line, []byte(`"ai-title"`)):
			var t struct {
				Type    string `json:"type"`
				AITitle string `json:"aiTitle"`
			}
			if json.Unmarshal(line, &t) == nil && t.Type == "ai-title" {
				info.AITitle = strings.TrimSpace(t.AITitle)
			}
		case info.Summary == "" && bytes.Contains(line, []byte(`"summary"`)):
			var s struct {
				Type    string `json:"type"`
				Summary string `json:"summary"`
			}
			if json.Unmarshal(line, &s) == nil && s.Type == "summary" {
				info.Summary = strings.TrimSpace(s.Summary)
			}
		}
		if !bytes.Contains(line, uuidKey) {
			continue
		}
		var rr rawRow
		if json.Unmarshal(line, &rr) != nil || rr.UUID == "" {
			continue
		}
		if info.SessionID == "" && rr.SessionID != "" {
			info.SessionID, info.Cwd, info.Version = rr.SessionID, rr.Cwd, rr.Version
			info.GitBranch, info.Entrypoint, info.First = rr.GitBranch, rr.Entrypoint, rr.Timestamp
		}
		if info.FirstPrompt == "" && rr.Type == "user" {
			row := Row{Role: User, Meta: rr.IsMeta, CompactSummary: rr.IsCompactSummary}
			if rr.Message != nil {
				row.Blocks = p.blocks(rr.Message.Content)
			}
			info.FirstPrompt = row.PromptText()
		}
		if info.FirstPrompt != "" && info.AITitle != "" {
			break
		}
	}
	return info, nil
}

// LastActivity is the time of the last user or assistant row, read from the
// end of the file; zero when there is none. It is not the file's mtime: the
// CLI appends cost, mode and title lines after the last row, sometimes
// weeks later when a session is reopened without a turn.
func LastActivity(path string) (time.Time, error) {
	return lastActivity(path, parser{skipBinary: true})
}

func lastActivity(path string, p parser) (time.Time, error) {
	f, err := open(path)
	if err != nil {
		return time.Time{}, err
	}
	defer f.Close()
	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return time.Time{}, err
	}
	// Usually under 1 KB follows the last row, but one attachment line
	// can be 140 KB, so the window doubles.
	for chunk := int64(64 << 10); ; chunk *= 2 {
		start := size - chunk
		if start < 0 {
			start = 0
		}
		buf := make([]byte, size-start)
		if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
			return time.Time{}, err
		}
		// The last piece follows the final newline (empty, or a line
		// still being written); the first is cut mid-line unless the
		// window reaches the file start.
		lines := bytes.Split(buf, []byte{'\n'})
		first := 0
		if start > 0 {
			first = 1
		}
		for i := len(lines) - 2; i >= first; i-- {
			for _, row := range p.rows(lines[i], 0, 0) {
				if row.Role == User || row.Role == Assistant {
					return row.Time, nil
				}
			}
		}
		if start == 0 {
			return time.Time{}, nil
		}
	}
}

// Used is what a session last ran with, whichever client sent it (this
// app, a terminal, VS Code): the model of the last real reply and the
// permission mode of the last message sent. Only typed messages carry the
// mode, so in a long turn it can sit megabytes before the end. Title is
// the name /rename gave it: each rename appends a {"type":"custom-title",
// "customTitle"} line, the last one counts.
type Used struct {
	Model string `json:"model,omitempty"`
	Mode  string `json:"mode,omitempty"`
	Title string `json:"title,omitempty"`
}

var modelKey, modeKey, customTitleKey = []byte(`"model"`), []byte(`"permissionMode"`), []byte(`"custom-title"`)

// take reads what one line says; keep says whether a value already found
// stands (reading backwards) or gives way (reading forwards).
func (u *Used) take(p parser, line []byte, keep bool) {
	if bytes.Contains(line, customTitleKey) {
		var t struct {
			Type        string `json:"type"`
			CustomTitle string `json:"customTitle"`
		}
		if json.Unmarshal(line, &t) == nil && t.Type == "custom-title" && !(keep && u.Title != "") {
			u.Title = strings.TrimSpace(t.CustomTitle)
		}
		return
	}
	// Reading back with both found, only a title is still sought: no need
	// to parse every reply on the way (it made the index ten times slower).
	if keep && u.Model != "" && u.Mode != "" {
		return
	}
	if !bytes.Contains(line, modelKey) && !bytes.Contains(line, modeKey) {
		return
	}
	row, ok := p.row(line, 0, 0)
	if !ok {
		return
	}
	if row.Role == Assistant && !row.APIError && row.Model != "" && row.Model != "<synthetic>" && !(keep && u.Model != "") {
		u.Model = row.Model
	}
	if row.Role == User && row.PermissionMode != "" && !(keep && u.Mode != "") {
		u.Mode = row.PermissionMode
	}
}

// LastUsed reads backwards from the end until it has the model, the mode
// and a custom title, or has read maxBytes (most sessions were never
// renamed, so this usually reads to the cap or the start).
func LastUsed(path string, maxBytes int64) (Used, error) {
	var u Used
	f, err := open(path)
	if err != nil {
		return u, err
	}
	defer f.Close()
	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return u, err
	}
	p := parser{skipBinary: true}
	for chunk := int64(256 << 10); ; chunk *= 2 {
		start := max(size-min(chunk, maxBytes), 0)
		buf := make([]byte, size-start)
		if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
			return u, err
		}
		lines := bytes.Split(buf, []byte{'\n'})
		first := 0
		if start > 0 {
			first = 1 // cut mid-line
		}
		u = Used{}
		all := func() bool { return u.Model != "" && u.Mode != "" && u.Title != "" }
		for i := len(lines) - 2; i >= first && !all(); i-- {
			u.take(p, lines[i], true)
		}
		if all() || start == 0 || chunk >= maxBytes {
			return u, nil
		}
		if u.Model != "" && u.Mode != "" {
			chunk = maxBytes / 2 // only a title is missing: one read to the cap, not several doublings
		}
	}
}

// UsedSince updates prev with the lines from offset from to the end, for a
// file that grew: only the new part is read. A line cut at from (still
// being written when prev was read) is read whole.
func UsedSince(path string, from int64, prev Used) (Used, error) {
	f, err := open(path)
	if err != nil {
		return prev, err
	}
	defer f.Close()
	size, err := f.Seek(0, io.SeekEnd)
	if err != nil || size <= from {
		return prev, err
	}
	// Back up to the start of the line from falls in.
	start := from
	for start > 0 {
		back := max(start-4096, 0)
		buf := make([]byte, start-back)
		if _, err := f.ReadAt(buf, back); err != nil && err != io.EOF {
			return prev, err
		}
		if i := bytes.LastIndexByte(buf, '\n'); i >= 0 {
			start = back + int64(i) + 1
			break
		}
		start = back
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return prev, err
	}
	lines := bytes.Split(buf, []byte{'\n'})
	p := parser{skipBinary: true}
	for _, line := range lines[:len(lines)-1] { // the last piece is unfinished or empty
		prev.take(p, line, false)
	}
	return prev, nil
}

// ProjectsRoot is ~/.claude/projects.
func ProjectsRoot() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "projects")
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

// ProjectDir is the folder under ProjectsRoot where the CLI keeps the
// transcripts for cwd: every non-alphanumeric character becomes "-". The
// drive letter keeps whatever case the spawner used, so look the folder up
// with the cwd the CLI was given.
func ProjectDir(cwd string) string {
	return filepath.Join(ProjectsRoot(), nonAlnum.ReplaceAllString(cwd, "-"))
}

// SessionPath is the transcript file for a session started in cwd.
func SessionPath(cwd, sessionID string) string {
	return filepath.Join(ProjectDir(cwd), sessionID+".jsonl")
}
