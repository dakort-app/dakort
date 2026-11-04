package transcript

import (
	"os"
	"syscall"
)

// open opens a transcript for reading without blocking its deletion. A file
// opened with os.Open cannot be deleted or renamed on Windows until it is
// closed, and the server reads transcripts every few seconds while the CLI
// (cleanupPeriodDays), the person, or a test cleanup may delete them.
func open(path string) (*os.File, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}
