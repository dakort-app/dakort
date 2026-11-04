//go:build !windows

package transcript

import "os"

// open opens a transcript for reading. Elsewhere an open file never blocks
// its deletion; see open_windows.go.
func open(path string) (*os.File, error) { return os.Open(path) }
