package procs

import (
	"errors"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	ntdll    = syscall.NewLazyDLL("ntdll.dll")

	procCreateJobObject           = kernel32.NewProc("CreateJobObjectW")
	procAssignProcessToJobObject  = kernel32.NewProc("AssignProcessToJobObject")
	procQueryInformationJobObject = kernel32.NewProc("QueryInformationJobObject")
	procQueryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
	procReadProcessMemory         = kernel32.NewProc("ReadProcessMemory")
	procNtQueryInformationProcess = ntdll.NewProc("NtQueryInformationProcess")
)

const (
	processTerminate               = 0x0001
	processVMRead                  = 0x0010
	processSetQuota                = 0x0100
	processQueryInformation        = 0x0400
	processQueryLimitedInformation = 0x1000

	jobObjectBasicProcessIDList = 3
	errorMoreData               = syscall.Errno(234)
)

// Job is one session's register of processes.
type Job struct {
	h    syscall.Handle
	mu   sync.Mutex
	info map[int]Info // what is known about each pid, read once
}

func New() (*Job, error) {
	h, _, err := procCreateJobObject.Call(0, 0)
	if h == 0 {
		return nil, err
	}
	return &Job{h: syscall.Handle(h), info: map[int]Info{}}, nil
}

// Add puts a running process in the job; what it starts from then on is
// in it too.
func (j *Job) Add(pid int) error {
	h, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(pid))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)
	if r, _, err := procAssignProcessToJobObject.Call(uintptr(j.h), uintptr(h)); r == 0 {
		return err
	}
	return nil
}

// pids lists the processes in the job now.
func (j *Job) pids() []int {
	// JOBOBJECT_BASIC_PROCESS_ID_LIST: two uint32 counts, then one
	// uintptr per process. A list longer than the buffer comes back as
	// far as it fits, with ERROR_MORE_DATA.
	buf := make([]uint64, 1+1024)
	r, _, err := procQueryInformationJobObject.Call(uintptr(j.h), jobObjectBasicProcessIDList,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*8), 0)
	if r == 0 && err != errorMoreData {
		return nil
	}
	n := int(uint32(buf[0] >> 32))
	if n > len(buf)-1 {
		n = len(buf) - 1
	}
	out := make([]int, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, int(buf[1+i]))
	}
	return out
}

// Running lists the job's processes with what is known of them, oldest
// first. Console hosts (conhost.exe) are left out: each belongs to one of
// the others and goes with it.
func (j *Job) Running() []Info {
	pids := j.pids()
	j.mu.Lock()
	defer j.mu.Unlock()
	live := map[int]bool{}
	var out []Info
	for _, pid := range pids {
		live[pid] = true
		in, ok := j.info[pid]
		if !ok {
			in = describe(pid)
			j.info[pid] = in
		}
		if in.Name == "conhost.exe" {
			continue
		}
		out = append(out, in)
	}
	for pid := range j.info {
		if !live[pid] {
			delete(j.info, pid)
		}
	}
	sort.Slice(out, func(a, b int) bool {
		if !out[a].Started.Equal(out[b].Started) {
			return out[a].Started.Before(out[b].Started)
		}
		return out[a].PID < out[b].PID
	})
	return out
}

// Has says whether the job lists pid now.
func (j *Job) Has(pid int) bool {
	for _, p := range j.pids() {
		if p == pid {
			return true
		}
	}
	return false
}

var ErrNotOurs = errors.New("not a process this session started")

// Stop ends one process the job lists. Anything else is refused.
func (j *Job) Stop(pid int) error {
	if !j.Has(pid) {
		return ErrNotOurs
	}
	h, err := syscall.OpenProcess(processTerminate, false, uint32(pid))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)
	return syscall.TerminateProcess(h, 1)
}

func (j *Job) Close() {
	syscall.CloseHandle(j.h)
}

// describe reads a process's program, start time, command line and
// working folder. The last two live in the process's own memory (its PEB)
// and need a fuller handle than the name does; without one they stay empty.
func describe(pid int) Info {
	in := Info{PID: pid}
	full := true
	h, err := syscall.OpenProcess(processQueryInformation|processVMRead, false, uint32(pid))
	if err != nil {
		full = false
		if h, err = syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid)); err != nil {
			return in
		}
	}
	defer syscall.CloseHandle(h)
	var name [1024]uint16
	size := uint32(len(name))
	if r, _, _ := procQueryFullProcessImageName.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&size))); r != 0 {
		in.Name = filepath.Base(syscall.UTF16ToString(name[:size]))
	}
	var created, exited, kernel, user syscall.Filetime
	if syscall.GetProcessTimes(h, &created, &exited, &kernel, &user) == nil {
		in.Started = time.Unix(0, created.Nanoseconds())
	}
	if full {
		in.Command, in.Dir = params(h)
		if len(in.Command) > maxCommand {
			in.Command = in.Command[:maxCommand] + "…"
		}
	}
	return in
}

// params reads a 64-bit process's command line and working folder from
// its RTL_USER_PROCESS_PARAMETERS (PEB+0x20; CommandLine at 0x70 and
// CurrentDirectory.DosPath at 0x38 in it, both UNICODE_STRINGs).
func params(h syscall.Handle) (command, dir string) {
	var pbi struct {
		Reserved1       uintptr
		PebBaseAddress  uintptr
		Reserved2       [2]uintptr
		UniqueProcessID uintptr
		Reserved3       uintptr
	}
	var got uint32
	if r, _, _ := procNtQueryInformationProcess.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&pbi)), unsafe.Sizeof(pbi), uintptr(unsafe.Pointer(&got))); r != 0 || pbi.PebBaseAddress == 0 {
		return "", ""
	}
	var p uintptr
	if !readMemory(h, pbi.PebBaseAddress+0x20, unsafe.Pointer(&p), unsafe.Sizeof(p)) || p == 0 {
		return "", ""
	}
	return readUnicode(h, p+0x70), readUnicode(h, p+0x38)
}

func readUnicode(h syscall.Handle, addr uintptr) string {
	var us struct {
		Length, MaximumLength uint16
		_                     [4]byte
		Buffer                uintptr
	}
	if !readMemory(h, addr, unsafe.Pointer(&us), unsafe.Sizeof(us)) || us.Buffer == 0 || us.Length == 0 {
		return ""
	}
	n := int(us.Length) / 2
	if n > 4096 {
		n = 4096
	}
	buf := make([]uint16, n)
	if !readMemory(h, us.Buffer, unsafe.Pointer(&buf[0]), uintptr(n*2)) {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

func readMemory(h syscall.Handle, addr uintptr, into unsafe.Pointer, size uintptr) bool {
	var n uintptr
	r, _, _ := procReadProcessMemory.Call(uintptr(h), addr, uintptr(into), size, uintptr(unsafe.Pointer(&n)))
	return r != 0 && n == size
}
