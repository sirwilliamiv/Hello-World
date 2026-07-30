// Package codegen renders capability templates into a client repository.
//
// It is the only provider in Phase 1, and it owns the single riskiest operation
// in the system: writing to a repository a human also edits. Every write it
// makes is either to a file Forge created and still owns (hash verified by the
// plan), or to a path that does not exist yet.
package codegen

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/originplatformlabs/forge/internal/diag"
	"github.com/originplatformlabs/forge/internal/plan"
)

type Provider struct{}

func New() *Provider { return &Provider{} }

func (p *Provider) Name() string { return "codegen" }

// Validate is a read-only preflight: it fails before starting rather than
// halfway through, which the brief names as the worst outcome.
func (p *Provider) Validate(root string) []diag.Diagnostic {
	var out []diag.Diagnostic

	info, err := os.Stat(root)
	if err != nil {
		out = append(out, diag.Diagnostic{
			Severity: diag.Error, Check: "FORGE020", File: root,
			Message: fmt.Sprintf("target directory does not exist: %v", err),
			Fix:     "create the directory, or run `forge init` to scaffold a new product",
		})
		return out
	}
	if !info.IsDir() {
		out = append(out, diag.Diagnostic{
			Severity: diag.Error, Check: "FORGE020", File: root,
			Message: "target path is not a directory",
			Fix:     "point -C at a directory",
		})
		return out
	}

	probe := filepath.Join(root, ".forge", ".write-probe")
	if err := os.MkdirAll(filepath.Dir(probe), 0o755); err != nil {
		out = append(out, diag.Diagnostic{
			Severity: diag.Error, Check: "FORGE020", File: root,
			Message: fmt.Sprintf("cannot create .forge directory: %v", err),
			Fix:     "check directory permissions",
		})
		return out
	}
	if err := os.WriteFile(probe, []byte("forge"), 0o644); err != nil {
		out = append(out, diag.Diagnostic{
			Severity: diag.Error, Check: "FORGE020", File: root,
			Message: fmt.Sprintf("target directory is not writable: %v", err),
			Fix:     "check directory permissions",
		})
		return out
	}
	_ = os.Remove(probe)
	return out
}

// Apply performs one action. Writes are atomic per file: a partially written
// source file is worse than none.
func (p *Provider) Apply(root string, a plan.Action) error {
	abs := filepath.Join(root, a.Path)

	switch a.Verb {
	case plan.Create, plan.Update:
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return fmt.Errorf("create directory for %s: %w", a.Path, err)
		}
		tmp := abs + ".forge-tmp"
		if err := os.WriteFile(tmp, a.Content, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", a.Path, err)
		}
		if err := os.Rename(tmp, abs); err != nil {
			return fmt.Errorf("install %s: %w", a.Path, err)
		}
		return nil

	case plan.Delete:
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", a.Path, err)
		}
		pruneEmptyDirs(root, filepath.Dir(abs))
		return nil

	case plan.NoOp, plan.Drift, plan.Adopted, plan.Ejected:
		return nil

	default:
		return fmt.Errorf("codegen: unknown action %q for %s", a.Verb, a.Path)
	}
}

// pruneEmptyDirs removes directories left empty by a deletion, stopping at the
// repository root so a delete never walks out of the project.
func pruneEmptyDirs(root, dir string) {
	root = filepath.Clean(root)
	for {
		dir = filepath.Clean(dir)
		if dir == root || !strings.HasPrefix(dir, root+string(filepath.Separator)) {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) > 0 {
			return
		}
		if os.Remove(dir) != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}
