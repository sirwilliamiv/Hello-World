// Package diag carries validation findings.
//
// The brief's constraint is that errors name the file, the line, and the fix.
// A Diagnostic that cannot say where to look and what to do is not finished, so
// File and Fix are part of the type rather than an afterthought.
package diag

import (
	"fmt"
	"sort"
	"strings"
)

type Severity string

const (
	Error   Severity = "error"
	Warning Severity = "warning"
)

// Diagnostic is one finding. Check is the stable identifier from
// ARCHITECTURE.md section 6, so a message can be traced to the rule that
// produced it.
type Diagnostic struct {
	Severity Severity
	Check    string // e.g. "FORGE003"
	File     string
	Line     int // 0 when unknown
	Path     string
	Message  string
	Fix      string
}

func (d Diagnostic) String() string {
	loc := d.File
	if loc == "" {
		loc = "<unknown>"
	}
	if d.Line > 0 {
		loc = fmt.Sprintf("%s:%d", loc, d.Line)
	}
	if d.Path != "" {
		loc = fmt.Sprintf("%s (%s)", loc, d.Path)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s [%s] %s\n  %s", d.Severity, d.Check, loc, d.Message)
	if d.Fix != "" {
		fmt.Fprintf(&b, "\n  fix: %s", d.Fix)
	}
	return b.String()
}

// Set accumulates diagnostics. Validation never short-circuits: one command run
// reports every problem it can find, not the first one.
type Set struct {
	items []Diagnostic
}

func (s *Set) Add(d Diagnostic) { s.items = append(s.items, d) }

func (s *Set) Errorf(check, file, path, fix, format string, args ...any) {
	s.Add(Diagnostic{Severity: Error, Check: check, File: file, Path: path, Fix: fix,
		Message: fmt.Sprintf(format, args...)})
}

func (s *Set) Warnf(check, file, path, fix, format string, args ...any) {
	s.Add(Diagnostic{Severity: Warning, Check: check, File: file, Path: path, Fix: fix,
		Message: fmt.Sprintf(format, args...)})
}

func (s *Set) Items() []Diagnostic { return s.items }

func (s *Set) HasErrors() bool {
	for _, d := range s.items {
		if d.Severity == Error {
			return true
		}
	}
	return false
}

func (s *Set) Count() (errors, warnings int) {
	for _, d := range s.items {
		if d.Severity == Error {
			errors++
		} else {
			warnings++
		}
	}
	return
}

// Sorted returns diagnostics ordered by check, file, then message, so output is
// stable across runs. Nondeterminism in a diff is a defect, and that includes
// the diff of a validate run in CI.
func (s *Set) Sorted() []Diagnostic {
	out := make([]Diagnostic, len(s.items))
	copy(out, s.items)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Check != out[j].Check {
			return out[i].Check < out[j].Check
		}
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Message < out[j].Message
	})
	return out
}
