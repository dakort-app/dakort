package term

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

// output collects what the PTY prints, read by one goroutine as the
// server does.
type output struct {
	mu   sync.Mutex
	b    bytes.Buffer
	done chan struct{}
}

func readAll(p PTY) *output {
	o := &output{done: make(chan struct{})}
	go func() {
		defer close(o.done)
		buf := make([]byte, 4096)
		for {
			n, err := p.Read(buf)
			o.mu.Lock()
			o.b.Write(buf[:n])
			o.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	return o
}

func (o *output) waitFor(t *testing.T, s string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		o.mu.Lock()
		got := o.b.String()
		o.mu.Unlock()
		if strings.Contains(got, s) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	t.Fatalf("no %q in the output:\n%s", s, o.b.String())
}

// The real shell starts in the folder asked for, runs what is typed and
// prints it back, takes a resize, and ends on Close with the read
// returning.
func TestShellRunsWhatIsTyped(t *testing.T) {
	dir := t.TempDir()
	p, err := Start(Shell(), dir, []string{"MADETEST_VAR=madetest-env-ok"}, 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	o := readAll(p)
	// The answer is computed, so the echo of the typed line does not
	// count as it.
	sh := strings.ToLower(Shell()[0])
	if strings.Contains(sh, "pwsh") || strings.Contains(sh, "powershell") {
		p.Write([]byte("echo \"madetest-$(20+22)\"; echo $env:MADETEST_VAR; (Get-Location).Path\r"))
	} else {
		p.Write([]byte("echo \"madetest-$((20+22))\"; echo \"$MADETEST_VAR\"; pwd\r"))
	}
	o.waitFor(t, "madetest-42")
	o.waitFor(t, "madetest-env-ok")
	o.waitFor(t, lastPart(dir))
	if err := p.Resize(120, 40); err != nil {
		t.Errorf("resize: %v", err)
	}
	p.Close()
	select {
	case <-o.done:
	case <-time.After(10 * time.Second):
		t.Fatal("the read did not end after Close")
	}
	waited := make(chan error, 1)
	go func() { waited <- p.Wait() }()
	select {
	case <-waited:
	case <-time.After(10 * time.Second):
		t.Fatal("the shell did not end after Close")
	}
}

// The shell exiting by itself ends Wait; Close then ends the read.
func TestShellExit(t *testing.T) {
	p, err := Start(Shell(), t.TempDir(), nil, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	o := readAll(p)
	p.Write([]byte("exit\r"))
	waited := make(chan error, 1)
	go func() { waited <- p.Wait() }()
	select {
	case <-waited:
	case <-time.After(20 * time.Second):
		t.Fatal("the shell did not exit")
	}
	p.Close()
	select {
	case <-o.done:
	case <-time.After(10 * time.Second):
		t.Fatal("the read did not end")
	}
}

func lastPart(p string) string {
	p = strings.TrimRight(strings.ReplaceAll(p, `\`, "/"), "/")
	return p[strings.LastIndex(p, "/")+1:]
}
