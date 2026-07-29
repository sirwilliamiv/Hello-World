// Package provider defines the pluggable backends that make something real.
//
// The interface exists in Phase 1 with only codegen implemented, so Phase 4's
// cloud provider is an addition rather than a refactor.
package provider

import (
	"github.com/originplatformlabs/forge/internal/diag"
	"github.com/originplatformlabs/forge/internal/plan"
)

// Provider is a backend that can plan and apply a class of change.
//
// Plan returns actions rather than performing them. That is what makes the
// read-only guarantee structural rather than a convention: a read-only command
// wraps a provider in ReadOnly, whose Apply panics, so a provider that mutates
// during plan fails loudly in tests instead of quietly in a client's repo.
type Provider interface {
	Name() string
	Validate(root string) []diag.Diagnostic
	Apply(root string, a plan.Action) error
}

// ReadOnly wraps a provider so any attempt to mutate is a programming error.
type ReadOnly struct{ Inner Provider }

func (r ReadOnly) Name() string                           { return r.Inner.Name() }
func (r ReadOnly) Validate(root string) []diag.Diagnostic { return r.Inner.Validate(root) }

func (r ReadOnly) Apply(string, plan.Action) error {
	panic("provider.ReadOnly: Apply called during a read-only command — " +
		"plan, validate, catalog, graph, and drift must never mutate")
}
