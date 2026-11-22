package term

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

// ConPTY, the Windows pseudo-console (Windows 10 1809 and later), called
// through kernel32 directly. The shell runs in a job object that kills
// everything it started when the terminal closes (or this server exits),
// so a dev server started in a terminal does not outlive it.

var (
	kernel32                    = syscall.NewLazyDLL("kernel32.dll")
	procCreatePseudoConsole     = kernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole     = kernel32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole      = kernel32.NewProc("ClosePseudoConsole")
	procInitializeAttributeList = kernel32.NewProc("InitializeProcThreadAttributeList")
	procUpdateAttribute         = kernel32.NewProc("UpdateProcThreadAttribute")
	procDeleteAttributeList     = kernel32.NewProc("DeleteProcThreadAttributeList")
	procCreateJobObject         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJob      = kernel32.NewProc("AssignProcessToJobObject")
	procResumeThread            = kernel32.NewProc("ResumeThread")
)

const (
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupInfoPresent       = 0x00080000
	createSuspended                  = 0x00000004
	createUnicodeEnvironment         = 0x00000400
	jobObjectExtendedLimitInfo       = 9
	jobObjectLimitKillOnJobClose     = 0x00002000
)

type startupInfoEx struct {
	syscall.StartupInfo
	attributeList uintptr
}

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION, 64-bit layout.
type jobLimits struct {
	perProcessUserTimeLimit int64
	perJobUserTimeLimit     int64
	limitFlags              uint32
	minimumWorkingSetSize   uintptr
	maximumWorkingSetSize   uintptr
	activeProcessLimit      uint32
	affinity                uintptr
	priorityClass           uint32
	schedulingClass         uint32
	ioInfo                  [6]uint64
	processMemoryLimit      uintptr
	jobMemoryLimit          uintptr
	peakProcessMemoryUsed   uintptr
	peakJobMemoryUsed       uintptr
}

type conPTY struct {
	hpc     uintptr
	in      *os.File // what is typed goes here
	out     *os.File // what the shell prints comes from here
	process syscall.Handle
	job     syscall.Handle
	once    sync.Once
}

func coord(cols, rows int) uintptr { return uintptr(uint32(rows)<<16 | uint32(cols)&0xffff) }

func shell() []string {
	root := os.Getenv("SystemRoot")
	if p, err := exec.LookPath("pwsh.exe"); err == nil {
		return []string{p, "-NoLogo"}
	}
	if p := firstFile(filepath.Join(root, `System32\WindowsPowerShell\v1.0\powershell.exe`)); p != "" {
		return []string{p, "-NoLogo"}
	}
	return []string{filepath.Join(root, `System32\cmd.exe`)}
}

func start(shell []string, dir string, env []string, cols, rows int) (PTY, error) {
	if err := procCreatePseudoConsole.Find(); err != nil {
		return nil, errors.New("this Windows has no pseudo-console (Windows 10 1809 or later needed)")
	}
	var inR, inW, outR, outW syscall.Handle
	if err := syscall.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, err
	}
	if err := syscall.CreatePipe(&outR, &outW, nil, 0); err != nil {
		syscall.CloseHandle(inR)
		syscall.CloseHandle(inW)
		return nil, err
	}
	t := &conPTY{in: os.NewFile(uintptr(inW), "pty-in"), out: os.NewFile(uintptr(outR), "pty-out")}
	r, _, _ := procCreatePseudoConsole.Call(coord(cols, rows), uintptr(inR), uintptr(outW), 0, uintptr(unsafe.Pointer(&t.hpc)))
	// The pseudo-console holds its own copies of its ends.
	syscall.CloseHandle(inR)
	syscall.CloseHandle(outW)
	if r != 0 {
		t.in.Close()
		t.out.Close()
		return nil, syscall.Errno(r)
	}
	if err := t.spawn(shell, dir, env); err != nil {
		t.Close()
		return nil, err
	}
	return t, nil
}

func (t *conPTY) spawn(shell []string, dir string, env []string) error {
	var size uintptr
	procInitializeAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	list := make([]byte, size)
	if r, _, err := procInitializeAttributeList.Call(uintptr(unsafe.Pointer(&list[0])), 1, 0, uintptr(unsafe.Pointer(&size))); r == 0 {
		return err
	}
	defer procDeleteAttributeList.Call(uintptr(unsafe.Pointer(&list[0])))
	if r, _, err := procUpdateAttribute.Call(uintptr(unsafe.Pointer(&list[0])), 0, procThreadAttributePseudoConsole, t.hpc, unsafe.Sizeof(t.hpc), 0, 0); r == 0 {
		return err
	}
	si := startupInfoEx{attributeList: uintptr(unsafe.Pointer(&list[0]))}
	si.Cb = uint32(unsafe.Sizeof(si))
	// No standard handles of ours: a server whose own output goes to a
	// log file would otherwise hand the shell that file instead of the
	// pseudo-console.
	si.Flags = syscall.STARTF_USESTDHANDLES

	args := make([]string, len(shell))
	for i, a := range shell {
		args[i] = syscall.EscapeArg(a)
	}
	cmdline, err := syscall.UTF16PtrFromString(strings.Join(args, " "))
	if err != nil {
		return err
	}
	cwd, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	block, err := envBlock(append(os.Environ(), env...))
	if err != nil {
		return err
	}
	var pi syscall.ProcessInformation
	flags := uint32(extendedStartupInfoPresent | createSuspended | createUnicodeEnvironment)
	if err := syscall.CreateProcess(nil, cmdline, nil, nil, false, flags, &block[0], cwd, &si.StartupInfo, &pi); err != nil {
		return err
	}
	defer syscall.CloseHandle(pi.Thread)
	t.process = pi.Process
	// Into a job that kills all of it on close, before it runs a thing.
	if job, _, _ := procCreateJobObject.Call(0, 0); job != 0 {
		var lim jobLimits
		lim.limitFlags = jobObjectLimitKillOnJobClose
		procSetInformationJobObject.Call(job, jobObjectExtendedLimitInfo, uintptr(unsafe.Pointer(&lim)), unsafe.Sizeof(lim))
		if r, _, _ := procAssignProcessToJob.Call(job, uintptr(pi.Process)); r != 0 {
			t.job = syscall.Handle(job)
		} else {
			syscall.CloseHandle(syscall.Handle(job))
		}
	}
	procResumeThread.Call(uintptr(pi.Thread))
	return nil
}

// envBlock is a Windows environment block: KEY=value strings, each ended
// by a NUL, then one more; a later KEY replaces an earlier one, as
// os/exec does.
func envBlock(env []string) ([]uint16, error) {
	seen := map[string]int{}
	var kept []string
	for _, kv := range env {
		// Keys like "=C:" (a drive's current folder) start with "=".
		i := strings.IndexByte(kv[min(1, len(kv)):], '=')
		if i < 0 {
			continue
		}
		key := strings.ToUpper(kv[:i+1])
		if j, dup := seen[key]; dup {
			kept[j] = kv
			continue
		}
		seen[key] = len(kept)
		kept = append(kept, kv)
	}
	var b []uint16
	for _, kv := range kept {
		u, err := syscall.UTF16FromString(kv) // ends with a NUL
		if err != nil {
			return nil, err
		}
		b = append(b, u...)
	}
	return append(b, 0), nil
}

func (t *conPTY) Read(p []byte) (int, error)  { return t.out.Read(p) }
func (t *conPTY) Write(p []byte) (int, error) { return t.in.Write(p) }

func (t *conPTY) Resize(cols, rows int) error {
	if r, _, _ := procResizePseudoConsole.Call(t.hpc, coord(clampSize(cols), clampSize(rows))); r != 0 {
		return syscall.Errno(r)
	}
	return nil
}

// Wait is called once, by the one goroutine that reads; it releases the
// process handle after.
func (t *conPTY) Wait() error {
	if t.process == 0 {
		return errors.New("not started")
	}
	_, err := syscall.WaitForSingleObject(t.process, syscall.INFINITE)
	syscall.CloseHandle(t.process)
	return err
}

func (t *conPTY) Close() error {
	t.once.Do(func() {
		if t.job != 0 {
			syscall.CloseHandle(t.job) // kills the shell and what it started
		} else if t.process != 0 {
			syscall.TerminateProcess(t.process, 1)
		}
		t.in.Close()
		// ClosePseudoConsole may wait until its last output is read
		// (before Windows 11 24H2), so the read end closes only after it,
		// while the reading goroutine drains it.
		procClosePseudoConsole.Call(t.hpc)
		t.out.Close()
	})
	return nil
}
