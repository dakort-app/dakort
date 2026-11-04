package server

import "testing"

func TestMainWindow(t *testing.T) {
	two := map[string]int{"claude-opus-5-5": 1_000_000, "claude-haiku-4-5": 200_000}
	cases := []struct {
		w     map[string]int
		model string
		want  int
	}{
		{two, "claude-opus-5-5", 1_000_000},
		{two, "claude-haiku-4-5", 200_000},
		{two, "claude-opus-5-5[1m]", 1_000_000}, // the suffix aside
		{two, "claude-sonnet-5-5", 0},           // not among several: unsure
		{map[string]int{"gpt-5.6-sol": 258_400}, "", 258_400},
		{nil, "claude-opus-5-5", 0},
	}
	for _, c := range cases {
		if got := mainWindow(c.w, c.model); got != c.want {
			t.Errorf("mainWindow(%v, %q) = %d, want %d", c.w, c.model, got, c.want)
		}
	}
}
