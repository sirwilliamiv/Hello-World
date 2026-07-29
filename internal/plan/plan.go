// Package plan computes the diff between declared and actual state.
//
// Planning mutates nothing. It reads state, hashes what is on disk, and returns
// the actions apply would take. The read-only guarantee is why a plan can be
// trusted enough to run unattended across a fleet.
package plan

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/originplatformlabs/forge/internal/render"
	"github.com/originplatformlabs/forge/internal/state"
)

type Verb string

const (
	// Create writes a file that does not exist yet.
	Create Verb = "create"
	// Update overwrites a managed file whose content Forge still owns.
	Update Verb = "update"
	// Delete removes a tracked file no longer produced by the resolved graph.
	Delete Verb = "delete"
	// NoOp means desired and actual already agree. A second apply must produce
	// nothing but these.
	NoOp Verb = "no-op"
	// Drift means a managed file was hand-edited. Reported, never silently
	// overwritten — that would be data loss in a client's repository.
	Drift Verb = "drift"
	// Adopted means a seeded file exists and belongs to the client now.
	Adopted Verb = "adopted"
	// Ejected means the file was deliberately released from management.
	Ejected Verb = "ejected"
)

// Action is one file-level change.
type Action struct {
	Verb       Verb
	Path       string
	Zone       state.Zone
	Capability string
	Template   string
	// Content is what apply would write. Empty for delete, drift, and no-op.
	Content []byte
	// Detail explains a non-obvious verb, e.g. why a file is drifted.
	Detail string

	rendered *render.Rendered
}

// Plan is the computed diff.
type Plan struct {
	Actions   []Action
	Workspace string
	Serial    int
}

// Counts summarises a plan for the one-line footer.
func (p *Plan) Counts() map[Verb]int {
	out := map[Verb]int{}
	for _, a := range p.Actions {
		out[a.Verb]++
	}
	return out
}

// HasChanges reports whether apply would write anything.
func (p *Plan) HasChanges() bool {
	for _, a := range p.Actions {
		switch a.Verb {
		case Create, Update, Delete:
			return true
		}
	}
	return false
}

// HasDrift reports whether any managed file was hand-edited.
func (p *Plan) HasDrift() bool {
	for _, a := range p.Actions {
		if a.Verb == Drift {
			return true
		}
	}
	return false
}

// Compute diffs the rendered desired state against what is on disk and in state.
func Compute(root string, s *state.State, desired []render.Rendered) (*Plan, error) {
	p := &Plan{Workspace: s.Workspace, Serial: s.Serial}
	seen := map[string]bool{}

	for i := range desired {
		d := desired[i]
		seen[d.Path] = true
		abs := filepath.Join(root, d.Path)

		onDisk, readErr := os.ReadFile(abs)
		missing := errors.Is(readErr, os.ErrNotExist)
		if readErr != nil && !missing {
			return nil, fmt.Errorf("read %s: %w", d.Path, readErr)
		}

		if s.IsEjected(d.Path) {
			p.Actions = append(p.Actions, Action{
				Verb: Ejected, Path: d.Path, Zone: d.Zone, Capability: d.Capability,
				Template: d.Template,
				Detail:   "released from management; no longer receives upgrades for this file",
			})
			continue
		}

		tracked, isTracked := s.FileByPath(d.Path)

		// Seeded files are written once and then belong to the client.
		if d.Zone == state.ZoneSeeded {
			switch {
			case missing:
				detail := "seeded once, then yours"
				if strings.Contains(d.Path, "/slots/") {
					detail = "slot stub — the sanctioned place for client-specific logic"
				}
				p.Actions = append(p.Actions, Action{
					Verb: Create, Path: d.Path, Zone: d.Zone, Capability: d.Capability,
					Template: d.Template, Content: d.Content, rendered: &d, Detail: detail,
				})
			default:
				p.Actions = append(p.Actions, Action{
					Verb: Adopted, Path: d.Path, Zone: d.Zone, Capability: d.Capability,
					Template: d.Template,
					Detail:   "owned by the client repository",
				})
			}
			continue
		}

		switch {
		case missing:
			p.Actions = append(p.Actions, Action{
				Verb: Create, Path: d.Path, Zone: d.Zone, Capability: d.Capability,
				Template: d.Template, Content: d.Content, rendered: &d,
			})

		case isTracked && tracked.GeneratedHash != "" && state.Hash(onDisk) != tracked.GeneratedHash:
			// The file on disk is not what Forge wrote. Report and refuse.
			p.Actions = append(p.Actions, Action{
				Verb: Drift, Path: d.Path, Zone: d.Zone, Capability: d.Capability,
				Template: d.Template,
				Detail: "hand-edited since Forge wrote it; apply will not overwrite it. " +
					"Re-apply with --accept-drift to discard the edit, or `forge eject` to keep it.",
			})

		case state.Hash(onDisk) == state.Hash(d.Content):
			p.Actions = append(p.Actions, Action{
				Verb: NoOp, Path: d.Path, Zone: d.Zone, Capability: d.Capability,
				Template: d.Template,
			})

		default:
			detail := "content changed"
			if isTracked && tracked.TemplateVersion != d.TemplateVersion {
				detail = fmt.Sprintf("template %s -> %s", tracked.TemplateVersion, d.TemplateVersion)
			}
			p.Actions = append(p.Actions, Action{
				Verb: Update, Path: d.Path, Zone: d.Zone, Capability: d.Capability,
				Template: d.Template, Content: d.Content, rendered: &d, Detail: detail,
			})
		}
	}

	// Anything tracked but no longer produced is a deletion — except seeded and
	// ejected files, which are the client's.
	for _, f := range s.Files {
		if seen[f.Path] || f.Zone == state.ZoneSeeded || s.IsEjected(f.Path) {
			continue
		}
		p.Actions = append(p.Actions, Action{
			Verb: Delete, Path: f.Path, Zone: f.Zone, Capability: f.Capability,
			Template: f.Template,
			Detail:   "no longer produced by the resolved graph",
		})
	}

	sort.SliceStable(p.Actions, func(i, j int) bool {
		if p.Actions[i].Verb != p.Actions[j].Verb {
			return verbRank(p.Actions[i].Verb) < verbRank(p.Actions[j].Verb)
		}
		return p.Actions[i].Path < p.Actions[j].Path
	})
	return p, nil
}

func verbRank(v Verb) int {
	switch v {
	case Drift:
		return 0
	case Create:
		return 1
	case Update:
		return 2
	case Delete:
		return 3
	case Ejected:
		return 4
	case Adopted:
		return 5
	default:
		return 6
	}
}

// Rendered returns the render result behind a writing action, if any.
func (a Action) Rendered() *render.Rendered { return a.rendered }
