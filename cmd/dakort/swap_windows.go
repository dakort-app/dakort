package main

// swapStaged is a no-op on Windows: a running program's file cannot be
// replaced, so the task's wrapper (start.cmd, written by dakort setup)
// swaps the staged build in after the server exits with code 75.
func swapStaged() {}
