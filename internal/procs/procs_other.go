//go:build !windows

package procs

import "errors"

// Job tracks nothing here: there is no process group a turn's CLI would
// keep its children in without also tying their lives to it.
type Job struct{}

func New() (*Job, error)         { return &Job{}, nil }
func (j *Job) Add(pid int) error { return nil }
func (j *Job) Running() []Info   { return nil }
func (j *Job) Has(pid int) bool  { return false }
func (j *Job) Close()            {}

var ErrNotOurs = errors.New("not a process this session started")

func (j *Job) Stop(pid int) error { return ErrNotOurs }
