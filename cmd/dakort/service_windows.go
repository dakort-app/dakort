package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// On Windows the service is a scheduled task that runs at boot, before
// anyone logs in, under the user's account with normal rights (S4U logon,
// Limited run level), running a cmd wrapper: it sets PATH, keeps the log,
// and restarts the server when it exits with code 75 after swapping in a
// staged build. Registering a task with a boot trigger needs
// administrator rights, so the install step runs elevated (one UAC
// prompt); when that is declined, the task runs from the user's next
// login instead, which needs none.

const defaultServiceName = "Dakort"

func installDir() (string, error) {
	root, err := os.UserCacheDir() // %LOCALAPPDATA%
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "dakort"), nil
}

type winService struct{ o setupOpts }

func newService(o setupOpts) service { return winService{o} }

func (s winService) bin() string    { return filepath.Join(s.o.home, "bin") }
func (s winService) logs() string   { return filepath.Join(s.o.home, "logs") }
func (s winService) exe() string    { return filepath.Join(s.bin(), "dakort.exe") }
func (s winService) staged() string { return s.exe() + ".new" }
func (s winService) log() string    { return filepath.Join(s.logs(), "server.log") }
func (s winService) wrapper() string {
	return filepath.Join(s.o.home, "start.cmd")
}

// definition is the wrapper the task runs. cmd.exe wants CRLF.
func (s winService) definition() string {
	var args []string
	for _, a := range s.o.serverArgs() {
		if strings.ContainsAny(a, " \t") {
			a = `"` + a + `"`
		}
		args = append(args, a)
	}
	lines := []string{
		"@echo off",
		fmt.Sprintf(`rem Run by the "%s" scheduled task. Written by dakort setup.`, s.o.name),
		fmt.Sprintf(`set "PATH=%s"`, servicePATH()),
		":run",
		fmt.Sprintf(`for %%%%F in ("%s") do if %%%%~zF GTR %d move /y "%s" "%s.old" >nul`, s.log(), serviceLogRoll, s.log(), s.log()),
		fmt.Sprintf(`echo [%%date%% %%time%%] starting >> "%s"`, s.log()),
		fmt.Sprintf(`"%s" %s >> "%s" 2>&1`, s.exe(), strings.Join(args, " "), s.log()),
		"set code=%errorlevel%",
		fmt.Sprintf(`echo [%%date%% %%time%%] exited with %%code%% >> "%s"`, s.log()),
		"rem 75: a restart was asked for; swap in the staged build, if any, and go again.",
		`if not "%code%"=="75" exit /b %code%`,
		fmt.Sprintf(`if exist "%s" move /y "%s" "%s" >> "%s" 2>&1`, s.staged(), s.staged(), s.exe(), s.log()),
		"goto run",
		"",
	}
	return strings.Join(lines, "\r\n")
}

func (s winService) installed() bool {
	return exec.Command("schtasks", "/Query", "/TN", s.o.name).Run() == nil
}

// running reports the task's wrapper as running (the task's state; a
// server whose wrapper died is Ready, not Running).
func (s winService) running() bool {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-ScheduledTask -TaskName '"+strings.ReplaceAll(s.o.name, "'", "''")+"' -ErrorAction SilentlyContinue).State").Output()
	return err == nil && strings.TrimSpace(string(out)) == "Running"
}

func (s winService) unchanged() bool {
	cur, err := os.ReadFile(s.wrapper())
	return err == nil && sameDefinition(string(cur), s.definition())
}

// installScript does the part that needs the task scheduler: stop the
// task, the wrapper and the server, put the new wrapper and the staged
// build in place, register, start.
//
// Stopping the task ends nothing (measured 2026-11-04: the wrapper and
// the server ran on). The wrapper is ended first, by the command line
// that names its file, then the server, by full path, so nothing else of
// that name is touched. The order matters: cmd.exe reads a batch file by
// byte offset as it runs, so a wrapper alive when its file is rewritten
// goes on reading the new text from the old offset the moment the server
// ends, and once started the old binary again from there, which then
// held the file the swap needed. So the new wrapper waits as start.cmd.new
// until the old one is gone.
const installScript = `param([string]$TaskName, [string]$Cmd, [string]$Exe, [string]$Staged, [switch]$AtLogon, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName $TaskName }
function Wrapper { Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($Cmd, [StringComparison]::OrdinalIgnoreCase) -ge 0 } }
function Server { Get-Process dakort -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } }
Wrapper | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Server | Stop-Process -Force
for ($i = 0; $i -lt 40 -and ((Wrapper) -or (Server)); $i++) { Start-Sleep -Milliseconds 250 }
if ($Remove) {
  if ($task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  exit 0
}
if (Test-Path "$Cmd.new") { Move-Item -Force "$Cmd.new" $Cmd }
if (Test-Path $Staged) { Move-Item -Force $Staged $Exe }
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\cmd.exe' -Argument "/d /c ` + "`\"`\"$Cmd`\"`\"" + `"
$user = "$env:USERDOMAIN\$env:USERNAME"
if ($AtLogon) {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
} else {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
}
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
`

func (s winService) runScript(args ...string) error {
	p := filepath.Join(s.o.home, "install.ps1")
	if err := os.WriteFile(p, []byte(strings.ReplaceAll(installScript, "\n", "\r\n")), 0o600); err != nil {
		return err
	}
	all := append([]string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", p,
		"-TaskName", s.o.name, "-Cmd", s.wrapper(), "-Exe", s.exe(), "-Staged", s.staged()}, args...)
	out, err := exec.Command("powershell", all...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s winService) install() error {
	// The new wrapper waits beside the old one; the script moves it in
	// once nothing runs the old one.
	if err := os.WriteFile(s.wrapper()+".new", []byte(s.definition()), 0o600); err != nil {
		return err
	}
	if elevated() {
		if err := s.runScript(); err != nil {
			return err
		}
		fmt.Printf("%s registered to run at boot\n", s.o.name)
		return nil
	}
	// Ask for administrator rights once; the elevated copy of this command
	// does the step and writes what it did to a file.
	out := filepath.Join(s.logs(), "setup-step.log")
	os.Remove(out)
	args := []string{"setup", "-install-step", "-out", out, "-name", s.o.name, "-home", s.o.home, "-port", fmt.Sprint(s.o.port)}
	if s.o.data != "" {
		args = append(args, "-data", s.o.data)
	}
	fmt.Println("registering the task to run at boot needs administrator rights once; asking...")
	err := runElevated(args)
	if text, rerr := os.ReadFile(out); rerr == nil && strings.TrimSpace(string(text)) != "" {
		fmt.Print(string(text))
	}
	if err == nil {
		return nil
	}
	if !errors.Is(err, errDeclined) {
		return err
	}
	fmt.Println("no administrator rights; registering it to run from your next login instead, which needs none")
	if err := s.runScript("-AtLogon"); err != nil {
		return err
	}
	fmt.Printf("%s registered to run from your next login (run dakort setup from an administrator terminal to have it run at boot instead)\n", s.o.name)
	return nil
}

func (s winService) remove() error {
	if !s.installed() {
		return nil
	}
	if elevated() {
		return s.runScript("-Remove")
	}
	out := filepath.Join(s.logs(), "setup-step.log")
	if err := runElevated([]string{"setup", "-uninstall", "-out", out, "-name", s.o.name, "-home", s.o.home}); err != nil {
		// A task registered at logon by this user can be removed by them.
		return s.runScript("-Remove")
	}
	return nil
}

var (
	kernel32dll = syscall.NewLazyDLL("kernel32.dll")
	shell32dll  = syscall.NewLazyDLL("shell32.dll")
)

// consoleReady makes the console show UTF-8 (the QR code's block
// characters) and ANSI colours.
func consoleReady() {
	kernel32dll.NewProc("SetConsoleOutputCP").Call(65001)
	h, err := syscall.GetStdHandle(syscall.STD_OUTPUT_HANDLE)
	if err != nil {
		return
	}
	var mode uint32
	if err := syscall.GetConsoleMode(h, &mode); err == nil {
		const virtualTerminal = 0x4
		kernel32dll.NewProc("SetConsoleMode").Call(uintptr(h), uintptr(mode|virtualTerminal))
	}
}

// elevated reports whether this process has administrator rights.
func elevated() bool {
	var t syscall.Token
	if err := syscall.OpenProcessToken(syscall.Handle(^uintptr(0)), syscall.TOKEN_QUERY, &t); err != nil { // the current process
		return false
	}
	defer t.Close()
	const tokenElevation = 20
	var e, n uint32
	if err := syscall.GetTokenInformation(t, tokenElevation, (*byte)(unsafe.Pointer(&e)), 4, &n); err != nil {
		return false
	}
	return e != 0
}

type shellExecuteInfo struct {
	size       uint32
	mask       uint32
	hwnd       uintptr
	verb       *uint16
	file       *uint16
	parameters *uint16
	directory  *uint16
	show       int32
	instApp    uintptr
	idList     uintptr
	class      *uint16
	keyClass   uintptr
	hotKey     uint32
	icon       uintptr
	process    syscall.Handle
}

// errDeclined is the UAC prompt answered No.
var errDeclined = errors.New("administrator rights declined")

// runElevated runs this binary again with args and administrator rights
// (the UAC prompt), hidden, and waits for it. errDeclined when the prompt
// is declined; another error when the step fails.
func runElevated(args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	var quoted []string
	for _, a := range args {
		quoted = append(quoted, syscall.EscapeArg(a))
	}
	const (
		noCloseProcess = 0x40
		noAsync        = 0x100
		hide           = 0
	)
	info := shellExecuteInfo{
		mask:       noCloseProcess | noAsync,
		verb:       syscall.StringToUTF16Ptr("runas"),
		file:       syscall.StringToUTF16Ptr(exe),
		parameters: syscall.StringToUTF16Ptr(strings.Join(quoted, " ")),
		show:       hide,
	}
	info.size = uint32(unsafe.Sizeof(info))
	ok, _, callErr := shell32dll.NewProc("ShellExecuteExW").Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		const errorCancelled = syscall.Errno(1223)
		if callErr == errorCancelled {
			return errDeclined
		}
		return callErr
	}
	defer syscall.CloseHandle(info.process)
	if _, err := syscall.WaitForSingleObject(info.process, syscall.INFINITE); err != nil {
		return err
	}
	var code uint32
	if err := syscall.GetExitCodeProcess(info.process, &code); err != nil {
		return err
	}
	if code != 0 {
		return errors.New("the elevated step failed")
	}
	return nil
}
