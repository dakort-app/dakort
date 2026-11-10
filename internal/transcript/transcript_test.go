package transcript_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dakort-app/dakort/internal/agent"
	"github.com/dakort-app/dakort/internal/claude"
	"github.com/dakort-app/dakort/internal/testcwd"
	"github.com/dakort-app/dakort/internal/transcript"
)

// A hand-written session covering every shape the survey of real files
// found: string and block content, images in prompts and tool results,
// attached context, meta rows, a compaction, non-row lines with and without
// a message, and a trailing partial line.
const pngDot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="

var fixtureLines = []string{
	`{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-08T02:55:26.270Z","sessionId":"s1"}`,
	`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>\nstuff\n</system-reminder>"},{"type":"text","text":"check the files"}]},"uuid":"u1","timestamp":"2026-10-08T02:55:26.467Z","cwd":"C:\\Users\\Sam Lee\\Desktop\\temp\\ben","sessionId":"s1","version":"2.1.300","gitBranch":"main","entrypoint":"claude-vscode"}`,
	`{"type":"api-request-blob","sessionId":"s1","hash":"abc","message":{"role":"user","content":[{"type":"text","text":"not a row"}]}}`,
	`{"type":"ai-title","aiTitle":" Checking files ","sessionId":"s1"}`,
	`{"parentUuid":"u1","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"sig"}],"stop_reason":null},"uuid":"a1","timestamp":"2026-10-08T02:55:30.000Z","sessionId":"s1"}`,
	`{"parentUuid":"a1","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use","usage":{"input_tokens":2,"cache_read_input_tokens":31763,"cache_creation_input_tokens":121,"output_tokens":50,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":121}}},"uuid":"a2","timestamp":"2026-10-08T02:55:31.000Z","sessionId":"s1"}`,
	`{"parentUuid":"a2","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"a.txt\nb.txt","is_error":false}]},"uuid":"u2","timestamp":"2026-10-08T02:55:32.000Z","sessionId":"s1","toolUseResult":{"stdout":"a.txt\nb.txt"}}`,
	`{"parentUuid":"u2","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":[{"type":"text","text":"shot"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + pngDot + `"}}]}]},"uuid":"u3","timestamp":"2026-10-08T02:55:33.000Z","sessionId":"s1"}`,
	`{"parentUuid":"u3","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_2","role":"assistant","content":[{"type":"text","text":"Two files."}],"stop_reason":"end_turn"},"uuid":"a3","timestamp":"2026-10-08T02:55:34.000Z","sessionId":"s1"}`,
	`{"parentUuid":"a3","isSidechain":false,"type":"user","message":{"role":"user","content":"<local-command-caveat>ran locally</local-command-caveat>"},"isMeta":true,"uuid":"u4","timestamp":"2026-10-08T02:55:35.000Z","sessionId":"s1"}`,
	`{"parentUuid":"u4","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + pngDot + `"}},{"type":"text","text":"what colour"}]},"uuid":"u5","timestamp":"2026-10-08T02:55:36.000Z","sessionId":"s1"}`,
	`{"parentUuid":"u5","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"uuid":"u6","timestamp":"2026-10-08T02:55:37.000Z","sessionId":"s1"}`,
	`{"parentUuid":null,"logicalParentUuid":"u6","isSidechain":false,"type":"system","subtype":"compact_boundary","content":"Conversation compacted","isMeta":false,"timestamp":"2026-10-08T02:55:38.000Z","uuid":"sys1","level":"info","compactMetadata":{"trigger":"manual","preTokens":32000},"sessionId":"s1"}`,
	`{"parentUuid":"sys1","isSidechain":false,"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation. Summary: files were checked."},"isCompactSummary":true,"isVisibleInTranscriptOnly":true,"uuid":"u7","timestamp":"2026-10-08T02:55:39.000Z","sessionId":"s1"}`,
	`{"type":"file-history-snapshot","messageId":"u7","snapshot":{"messageId":"u7","trackedFileBackups":{}},"isSnapshotUpdate":false}`,
	`{"parentUuid":"u7","isSidechain":false,"type":"user","message":{"role":"user","content":"and now?"},"uuid":"u8","timestamp":"2026-10-08T02:55:40.000Z","permissionMode":"auto","sessionId":"s1"}`,
	`{"type":"some-future-thing","uuid":"not-a-row","sessionId":"s1"}`,
}

const partialLine = `{"parentUuid":"u8","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_3","role":"assistant","content":[{"type":"text","text":"Still here."}],"stop_reason":"end_turn"},"uuid":"a4","timestamp":"2026-10-08T02:55:41.000Z","sessionId":"s1"}`

func writeFixture(t *testing.T, lines []string, partial string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "s1.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"+partial), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func uuids(rows []transcript.Row) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.UUID
	}
	return out
}

func TestRows(t *testing.T) {
	path := writeFixture(t, fixtureLines, partialLine)
	assets := transcript.Dir(filepath.Join(t.TempDir(), "assets"))
	r := &transcript.Reader{Path: path, Assets: assets}

	rows, next, err := r.After(0)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"u1", "a1", "a2", "u2", "u3", "a3", "u4", "u5", "u6", "sys1", "u7", "u8"}
	if got := uuids(rows); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("rows %v, want %v", got, want)
	}
	// The partial line is not consumed; next points at its start.
	fi, _ := os.Stat(path)
	if next != fi.Size()-int64(len(partialLine)) {
		t.Errorf("next %d, want %d", next, fi.Size()-int64(len(partialLine)))
	}
	byID := map[string]transcript.Row{}
	for _, row := range rows {
		byID[row.UUID] = row
		if row.End <= row.Offset {
			t.Errorf("%s: offset %d end %d", row.UUID, row.Offset, row.End)
		}
		if row.Time.IsZero() {
			t.Errorf("%s: no time", row.UUID)
		}
	}
	for i := 1; i < len(rows); i++ {
		if rows[i].Offset < rows[i-1].End {
			t.Errorf("rows %s and %s overlap", rows[i-1].UUID, rows[i].UUID)
		}
	}

	// Prompt with attached context: both blocks kept, PromptText strips the tag.
	u1 := byID["u1"]
	if len(u1.Blocks) != 2 || u1.PromptText() != "check the files" {
		t.Errorf("u1: blocks %d, prompt %q", len(u1.Blocks), u1.PromptText())
	}
	if u1.Parent != "" || u1.Role != transcript.User {
		t.Errorf("u1: parent %q role %q", u1.Parent, u1.Role)
	}
	// Redacted thinking.
	if a1 := byID["a1"]; len(a1.Blocks) != 1 || a1.Blocks[0].Type != "thinking" || a1.Blocks[0].Text != "" || a1.MessageID != "msg_1" {
		t.Errorf("a1: %+v", a1)
	}
	// Tool use and its result.
	if a2 := byID["a2"]; a2.Blocks[0].Type != "tool_use" || a2.Blocks[0].ID != "toolu_1" || a2.Blocks[0].Name != "Bash" || string(a2.Blocks[0].Input) != `{"command":"ls"}` || a2.StopReason != "tool_use" || a2.Context != 31886 || a2.CacheTTL != "1h" {
		t.Errorf("a2: %+v", a2)
	}
	if u2 := byID["u2"]; u2.Blocks[0].Type != "tool_result" || u2.Blocks[0].ID != "toolu_1" || len(u2.Blocks[0].Content) != 1 || u2.Blocks[0].Content[0].Text != "a.txt\nb.txt" || u2.PromptText() != "" {
		t.Errorf("u2: %+v", u2)
	}
	// Image inside a tool result and in a prompt: stored once, named by hash.
	dot, _ := base64.StdEncoding.DecodeString(pngDot)
	u3 := byID["u3"]
	img := u3.Blocks[0].Content[1]
	if img.Type != "image" || img.MediaType != "image/png" || img.Size != len(dot) || !strings.HasSuffix(img.Asset, ".png") {
		t.Errorf("u3 image: %+v", img)
	}
	u5 := byID["u5"]
	if u5.Blocks[0].Asset != img.Asset || u5.PromptText() != "what colour" {
		t.Errorf("u5: %+v", u5.Blocks[0])
	}
	if data, err := os.ReadFile(filepath.Join(string(assets), img.Asset)); err != nil || string(data) != string(dot) {
		t.Errorf("asset file: %v", err)
	}
	if entries, _ := os.ReadDir(string(assets)); len(entries) != 1 {
		t.Errorf("asset dir has %d files, want 1", len(entries))
	}
	// Meta, interrupt, compaction, plain string prompt.
	if u4 := byID["u4"]; !u4.Meta || u4.PromptText() != "" || len(u4.Blocks) != 1 {
		t.Errorf("u4: %+v", u4)
	}
	if u6 := byID["u6"]; u6.PromptText() != "" || u6.Blocks[0].Text != "[Request interrupted by user]" {
		t.Errorf("u6: %+v", u6)
	}
	if s := byID["sys1"]; s.Role != transcript.System || s.Subtype != "compact_boundary" || s.Content != "Conversation compacted" || s.Level != "info" || s.PreTokens != 32000 {
		t.Errorf("sys1: %+v", s)
	}
	if u7 := byID["u7"]; !u7.CompactSummary || u7.PromptText() != "" {
		t.Errorf("u7: %+v", u7)
	}
	if u8 := byID["u8"]; u8.PermissionMode != "auto" {
		t.Errorf("u8 permission mode %q, want auto", u8.PermissionMode)
	}
	if u8 := byID["u8"]; u8.PromptText() != "and now?" {
		t.Errorf("u8: %+v", u8)
	}
	// No base64 leaks into the row payload.
	if js, _ := json.Marshal(rows); strings.Contains(string(js), pngDot[:20]) {
		t.Error("base64 in row payload")
	}

	// Finish the partial line: After(next) picks it up.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("\n")
	f.Close()
	more, next2, err := r.After(next)
	if err != nil || len(more) != 1 || more[0].UUID != "a4" {
		t.Fatalf("After(next): %v %v", uuids(more), err)
	}
	fi, _ = os.Stat(path)
	if next2 != fi.Size() {
		t.Errorf("next2 %d, want %d", next2, fi.Size())
	}
	if again, _, _ := r.After(next2); len(again) != 0 {
		t.Errorf("After(end) gave %v", uuids(again))
	}

	// Offsets must sit on line starts.
	if _, _, err := r.After(next + 3); !errors.Is(err, transcript.ErrOffset) {
		t.Errorf("After(mid-line): %v", err)
	}
	if _, _, err := r.Tail(next+3, 5); !errors.Is(err, transcript.ErrOffset) {
		t.Errorf("Tail(mid-line): %v", err)
	}

	// No asset store: data dropped, size kept.
	plain := &transcript.Reader{Path: path}
	rows2, _ := plain.All()
	if b := rows2[4].Blocks[0].Content[1]; b.Asset != "" || b.Size != len(dot) {
		t.Errorf("no-store image: %+v", b)
	}
}

func TestTail(t *testing.T) {
	path := writeFixture(t, fixtureLines, partialLine)
	r := &transcript.Reader{Path: path}
	all, _ := r.All()

	// Page up from the end in threes until the start; the pages concatenate
	// to the full list.
	var pages [][]transcript.Row
	before := int64(-1)
	for {
		rows, atStart, err := r.Tail(before, 3)
		if err != nil {
			t.Fatal(err)
		}
		pages = append([][]transcript.Row{rows}, pages...)
		if atStart {
			break
		}
		if len(rows) == 0 {
			t.Fatal("empty page before the start")
		}
		before = rows[0].Offset
	}
	var joined []transcript.Row
	for _, p := range pages {
		joined = append(joined, p...)
	}
	if strings.Join(uuids(joined), ",") != strings.Join(uuids(all), ",") {
		t.Errorf("paged %v\nall   %v", uuids(joined), uuids(all))
	}
	if len(pages) != 4 {
		t.Errorf("%d pages, want 4", len(pages))
	}

	// A big n says atStart on the first page; the partial line is ignored.
	rows, atStart, _ := r.Tail(-1, 100)
	if !atStart || len(rows) != len(all) {
		t.Errorf("Tail(-1,100): %d rows atStart=%v", len(rows), atStart)
	}
	// Exactly n rows left is still the start.
	rows, atStart, _ = r.Tail(-1, len(all))
	if !atStart {
		t.Error("Tail with n == rows should report the start")
	}
	// An explicit offset at the end of the file behaves like -1.
	fi, _ := os.Stat(path)
	rows, _, err := r.Tail(fi.Size(), 2)
	if err != nil || len(rows) != 2 || rows[1].UUID != "u8" {
		t.Errorf("Tail(size,2): %v %v", uuids(rows), err)
	}
	// Tail at offset 0 is empty and at the start.
	rows, atStart, _ = r.Tail(0, 2)
	if len(rows) != 0 || !atStart {
		t.Errorf("Tail(0): %v %v", uuids(rows), atStart)
	}
}

func TestHead(t *testing.T) {
	path := writeFixture(t, fixtureLines, "")
	info, err := transcript.Head(path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	want := transcript.Info{
		SessionID: "s1", Cwd: `C:\Users\Sam Lee\Desktop\temp\ben`, Version: "2.1.300",
		GitBranch: "main", Entrypoint: "claude-vscode",
		First:   time.Date(2026, 10, 8, 2, 55, 26, 467e6, time.UTC),
		AITitle: "Checking files", FirstPrompt: "check the files",
	}
	info.Scanned = 0
	if !info.First.Equal(want.First) {
		t.Errorf("First %v, want %v", info.First, want.First)
	}
	info.First, want.First = time.Time{}, time.Time{}
	if info != want {
		t.Errorf("got %+v\nwant %+v", info, want)
	}
	// A tiny cap stops the scan after the first line.
	info, _ = transcript.Head(path, 10)
	if info.SessionID != "" || info.Scanned == 0 {
		t.Errorf("capped scan: %+v", info)
	}
}

// The last row's time, past bookkeeping lines bigger than the first window
// and a line still being written.
func TestLastActivity(t *testing.T) {
	big := `{"type":"attachment-ish","sessionId":"s1","pad":"` + strings.Repeat("x", 150<<10) + `"}`
	lines := append(append([]string{}, fixtureLines...), big, `{"type":"cost-state","sessionId":"s1"}`)
	got, err := transcript.LastActivity(writeFixture(t, lines, partialLine))
	if err != nil {
		t.Fatal(err)
	}
	if want, _ := time.Parse(time.RFC3339, "2026-10-08T02:55:40Z"); !got.Equal(want) {
		t.Errorf("got %v, want %v (u8, not the partial a4 or the system row)", got, want)
	}
	got, err = transcript.LastActivity(writeFixture(t, []string{`{"type":"cost-state","sessionId":"s1"}`}, ""))
	if err != nil || !got.IsZero() {
		t.Errorf("no rows: got %v, %v", got, err)
	}
}

// A compaction an hour after the last reply is not activity: its rows (the
// shape the CLI wrote on 2026-11-08) leave the time at the reply. A prompt
// after it counts again.
func TestLastActivityPastCompaction(t *testing.T) {
	user := func(uuid, ts, extra, content string) string {
		return `{"parentUuid":null,"type":"user",` + extra + `"message":{"role":"user","content":"` + content + `"},"uuid":"` + uuid + `","timestamp":"` + ts + `","sessionId":"s1"}`
	}
	compaction := []string{
		`{"type":"queue-operation","sessionId":"s1","timestamp":"2026-10-08T03:50:00.000Z"}`,
		`{"parentUuid":null,"type":"system","subtype":"compact_boundary","content":"Conversation compacted","uuid":"c1","timestamp":"2026-10-08T03:51:00.000Z","sessionId":"s1"}`,
		user("c2", "2026-10-08T03:51:00.000Z", `"isCompactSummary":true,`, "This session is being continued"),
		user("c3", "2026-10-08T03:50:00.000Z", `"isMeta":true,`, "<local-command-caveat>Caveat</local-command-caveat>"),
		user("c4", "2026-10-08T03:50:00.000Z", "", "<command-name>/compact</command-name>"),
		user("c5", "2026-10-08T03:51:01.000Z", "", "<local-command-stdout>Compacted </local-command-stdout>"),
		`{"type":"attachment","attachment":{"type":"compact_file_reference"},"uuid":"c6","timestamp":"2026-10-08T03:51:01.000Z","sessionId":"s1"}`,
	}
	lines := append(append([]string{}, fixtureLines...), compaction...)
	got, err := transcript.LastActivity(writeFixture(t, lines, ""))
	if err != nil {
		t.Fatal(err)
	}
	if want, _ := time.Parse(time.RFC3339, "2026-10-08T02:55:40Z"); !got.Equal(want) {
		t.Errorf("got %v, want %v (u8, before the compaction)", got, want)
	}
	lines = append(lines, user("p1", "2026-10-08T07:00:00.000Z", "", "good morning"))
	got, err = transcript.LastActivity(writeFixture(t, lines, ""))
	if want, _ := time.Parse(time.RFC3339, "2026-10-08T07:00:00Z"); err != nil || !got.Equal(want) {
		t.Errorf("a prompt after the compaction: got %v, %v, want %v", got, err, want)
	}
}

// What a session last ran with: read backwards on a first look, then only
// what the file gained, including a line that was half written before.
func TestUsed(t *testing.T) {
	// Tool output after the last typed message, as in a long turn: more
	// than the first 256 KB window, so the backward read has to widen.
	pad := `{"parentUuid":"u8","type":"user","message":{"role":"user","content":[{"tool_use_id":"t","type":"tool_result","content":"` + strings.Repeat("y", 300<<10) + `"}]},"uuid":"u9","timestamp":"2026-10-08T02:55:41.000Z","sessionId":"s1"}`
	path := writeFixture(t, append(append([]string{}, fixtureLines...), pad), "")
	got, err := transcript.LastUsed(path, 4<<20)
	if want := (transcript.Used{Model: "claude-opus-5-5", Mode: "auto"}); err != nil || got != want {
		t.Fatalf("LastUsed: %+v, %v; want %+v", got, err, want)
	}
	if got, _ := transcript.LastUsed(path, 64<<10); got.Mode != "" {
		t.Errorf("a 64 KB cap still found the mode %q past 300 KB of output", got.Mode)
	}

	// The file grows: a new message in plan mode, half written at first.
	fi, _ := os.Stat(path)
	before := fi.Size()
	msg := `{"parentUuid":"u9","type":"user","message":{"role":"user","content":"plan it"},"uuid":"u10","timestamp":"2026-10-08T02:56:00.000Z","permissionMode":"plan","sessionId":"s1"}`
	reply := `{"parentUuid":"u10","type":"assistant","message":{"model":"claude-haiku-5-5","id":"m9","role":"assistant","content":[{"type":"text","text":"ok"}]},"uuid":"a9","timestamp":"2026-10-08T02:56:01.000Z","sessionId":"s1"}`
	appendTo := func(s string) {
		f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		f.WriteString(s)
		f.Close()
	}
	appendTo(msg[:40])
	got, _ = transcript.UsedSince(path, before, got)
	if got.Mode != "auto" {
		t.Errorf("a half-written line changed the mode to %q", got.Mode)
	}
	fi, _ = os.Stat(path)
	mid := fi.Size()
	appendTo(msg[40:] + "\n" + reply + "\n")
	got, err = transcript.UsedSince(path, mid, got)
	if want := (transcript.Used{Model: "claude-haiku-5-5", Mode: "plan"}); err != nil || got != want {
		t.Errorf("UsedSince from mid-line: %+v, %v; want %+v", got, err, want)
	}

	// Renames: the last custom-title line counts, read back or forward.
	fi, _ = os.Stat(path)
	before = fi.Size()
	appendTo(`{"type":"custom-title","customTitle":"First","sessionId":"s1"}` + "\n" + `{"type":"custom-title","customTitle":" Second ","sessionId":"s1"}` + "\n")
	if got, _ = transcript.UsedSince(path, before, got); got.Title != "Second" {
		t.Errorf("UsedSince title %q, want Second", got.Title)
	}
	if back, _ := transcript.LastUsed(path, 4<<20); back.Title != "Second" || back.Mode != "plan" {
		t.Errorf("LastUsed after renames: %+v", back)
	}
}

func TestProjectDir(t *testing.T) {
	got := transcript.ProjectDir(`c:\Users\Sam Lee\Desktop\temp\ben`)
	if filepath.Base(got) != "c--Users-Sam-Lee-Desktop-temp-ben" {
		t.Errorf("ProjectDir: %s", got)
	}
}

// The 48 MB stress session, when DAKORT_STRESS_SESSION names it (the ship
// script does). Counts come from a Python survey of the file on 2026-10-21.
func TestBigSession(t *testing.T) {
	path := os.Getenv("DAKORT_STRESS_SESSION")
	if _, err := os.Stat(path); path == "" || err != nil {
		t.Skip("stress fixture not present (DAKORT_STRESS_SESSION)")
	}
	assets := transcript.Dir(filepath.Join(t.TempDir(), "assets"))
	r := &transcript.Reader{Path: path, Assets: assets}

	t0 := time.Now()
	rows, err := r.All()
	if err != nil {
		t.Fatal(err)
	}
	allTime := time.Since(t0)
	roles := map[transcript.Role]int{}
	images, docs := 0, 0
	seen := map[string]bool{}
	var count func(bs []transcript.Block)
	count = func(bs []transcript.Block) {
		for _, b := range bs {
			switch b.Type {
			case "image":
				images++
				if b.Asset == "" {
					t.Errorf("image without asset")
				}
			case "document":
				docs++
			}
			count(b.Content)
		}
	}
	for _, row := range rows {
		roles[row.Role]++
		if seen[row.UUID] {
			t.Errorf("duplicate uuid %s", row.UUID)
		}
		seen[row.UUID] = true
		count(row.Blocks)
	}
	if roles[transcript.User] != 810 || roles[transcript.Assistant] != 1083 || roles[transcript.System] != 5 {
		t.Errorf("roles %v, want user 810 assistant 1083 system 5", roles)
	}
	if images != 69+25 {
		t.Errorf("%d images, want 94", images)
	}
	entries, _ := os.ReadDir(string(assets))
	js, _ := json.Marshal(rows)
	if strings.Contains(string(js), `"data":`) {
		t.Error("base64 source in payload")
	}

	// Paging: the newest 50 by Tail, then everything since the midpoint.
	t1 := time.Now()
	tail, atStart, err := r.Tail(-1, 50)
	tailTime := time.Since(t1)
	if err != nil || atStart || len(tail) != 50 || tail[49].UUID != rows[len(rows)-1].UUID {
		t.Errorf("Tail(-1,50): %d rows atStart=%v err=%v", len(tail), atStart, err)
	}
	// The cursor ends at the file size: bookkeeping lines follow the last row.
	mid := rows[len(rows)/2]
	fi, _ := os.Stat(path)
	since, next, err := r.After(mid.Offset)
	if err != nil || len(since) != len(rows)-len(rows)/2 || since[0].UUID != mid.UUID || next != fi.Size() {
		t.Errorf("After(mid): %d rows next=%d err=%v", len(since), next, err)
	}

	t2 := time.Now()
	info, err := transcript.Head(path, 1<<20)
	headTime := time.Since(t2)
	if err != nil || info.AITitle != "Last three doc files in downloads" || info.FirstPrompt != "check the last three doc files in downloads" || info.SessionID != "528d9def-5290-4c75-9f2f-bee41c4a04a0" {
		t.Errorf("Head: %+v %v", info, err)
	}
	t.Logf("rows %d (%v), images %d (%d distinct files), payload %.1f MB, All %v, Tail(50) %v, Head %v (%d KB)",
		len(rows), roles, images, len(entries), float64(len(js))/1e6, allTime, tailTime, headTime, info.Scanned>>10)
}

// A real turn, then its transcript: the uuid the CLI echoes for the prompt
// is the row the reader finds, with the typed text and the reply after it.
func TestRealTurn(t *testing.T) {
	if testing.Short() {
		t.Skip("real CLI test")
	}
	bin, err := claude.FindBinary()
	if err != nil {
		t.Skip(err)
	}
	cwd := testcwd.New(t)
	id := testcwd.UUID()
	p, err := claude.Start(context.Background(), claude.Options{
		Bin: bin, Cwd: cwd, Model: "haiku", SessionID: id, ReplayUserMessages: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	const prompt = "Reply with exactly one word: pineapple"
	if err := p.Send(agent.Message{Text: prompt}); err != nil {
		t.Fatal(err)
	}
	var promptUUID string
	var result *agent.Result
	for ev := range p.Events() {
		if ev.Kind == agent.KindUser && promptUUID == "" {
			promptUUID = ev.UUID
		}
		if ev.Kind == agent.KindResult {
			result = ev.Result
			break
		}
	}
	if result == nil || !result.OK {
		t.Fatalf("turn failed: %+v", result)
	}
	p.Close()

	r := &transcript.Reader{Path: transcript.SessionPath(cwd, id)}
	rows, err := r.All()
	if err != nil {
		t.Fatal(err)
	}
	var found, replied bool
	for i, row := range rows {
		if row.UUID == promptUUID {
			found = true
			if row.PromptText() != prompt {
				t.Errorf("prompt row text %q", row.PromptText())
			}
			for _, later := range rows[i+1:] {
				for _, b := range later.Blocks {
					if later.Role == transcript.Assistant && b.Type == "text" && strings.Contains(strings.ToLower(b.Text), "pineapple") {
						replied = true
					}
				}
			}
		}
	}
	if !found || !replied {
		t.Errorf("prompt uuid %q found=%v replied=%v in %v", promptUUID, found, replied, uuids(rows))
	}
	info, _ := transcript.Head(r.Path, 1<<20)
	if info.SessionID != id || info.Cwd != cwd || info.FirstPrompt != prompt {
		t.Errorf("Head: %+v", info)
	}
}
