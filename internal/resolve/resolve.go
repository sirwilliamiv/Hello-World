// Package resolve turns a manifest plus a catalog into a resolved graph.
//
// The pipeline is CLOSE -> SUBSTITUTE -> RESOLVE, matching ARCHITECTURE.md
// section 3. It is deliberately free of I/O so it can be tested exhaustively;
// the brief singles out dependency resolution as one of the parts that silently
// corrupts a client when it is wrong.
package resolve

import (
	"fmt"
	"sort"
	"strings"

	"github.com/originplatformlabs/forge/internal/catalog"
	"github.com/originplatformlabs/forge/internal/diag"
	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/spec"
)

// Node is one capability in the resolved graph.
type Node struct {
	Cap *spec.Capability

	// Selected is true when the manifest named this capability directly. False
	// means it was pulled in as a dependency.
	Selected bool

	// ReasonChain explains why a dependency is present, e.g.
	// ["pay.invoices", "docs.generation"] meaning pay.invoices pulled in
	// docs.generation. Empty for a directly selected capability.
	ReasonChain []string

	// Reason is the declared justification from the requires edge that pulled
	// this in. Shown in plan output so an addition is never a surprise.
	Reason string

	// SupersededBy names the upgrade that took over this capability's slot. A
	// superseded capability stays in the graph — its exposed interface survives
	// and consumers keep calling it — but it no longer provides the
	// implementation.
	SupersededBy string
}

// Superseded reports whether an upgrade has taken over this capability's slot.
func (n *Node) Superseded() bool { return n.SupersededBy != "" }

// Graph is the resolved product.
type Graph struct {
	Nodes map[string]*Node

	// Order is a deterministic topological ordering: dependencies before
	// dependents, ties broken by id. Apply walks this.
	Order []string
}

// Active returns nodes that provide an implementation, in graph order,
// excluding those an upgrade has superseded.
func (g *Graph) Active() []*Node {
	var out []*Node
	for _, id := range g.Order {
		if n := g.Nodes[id]; !n.Superseded() {
			out = append(out, n)
		}
	}
	return out
}

// All returns every node in graph order, superseded ones included.
func (g *Graph) All() []*Node {
	out := make([]*Node, 0, len(g.Order))
	for _, id := range g.Order {
		out = append(out, g.Nodes[id])
	}
	return out
}

func (g *Graph) Has(id string) bool { _, ok := g.Nodes[id]; return ok }

// Resolve computes the graph. Diagnostics accumulate; resolution returns a
// best-effort graph even when it reports errors, so later validation checks can
// still run and report everything in one pass.
func Resolve(m *manifest.Manifest, cat *catalog.Catalog) (*Graph, *diag.Set) {
	ds := &diag.Set{}
	g := &Graph{Nodes: map[string]*Node{}}

	// The kernel is mandatory and implicit: always present, never listed in a
	// manifest.
	for _, k := range cat.Kernel() {
		g.Nodes[k.ID] = &Node{Cap: k}
	}

	// CLOSE: add manifest selections and walk their requires-closure.
	for i, sel := range m.Capabilities {
		path := fmt.Sprintf("capabilities/%d/id", i)
		if !sel.IsEnabled() {
			continue
		}
		cap, ok := cat.Get(sel.ID)
		if !ok {
			ds.Add(diag.Diagnostic{
				Severity: diag.Error, Check: "FORGE003", File: m.SourceFile,
				Line: m.Line(path), Path: path,
				Message: fmt.Sprintf("capability %q is not in catalog snapshot %s", sel.ID, m.Catalog.Snapshot),
				Fix:     fmt.Sprintf("run `forge catalog` to list available capabilities, or correct the id at %s", path),
			})
			continue
		}
		if cap.IsKernel() {
			ds.Add(diag.Diagnostic{
				Severity: diag.Error, Check: "FORGE003", File: m.SourceFile,
				Line: m.Line(path), Path: path,
				Message: fmt.Sprintf("%q is a kernel capability and is present in every product by definition", sel.ID),
				Fix:     fmt.Sprintf("remove the entry at %s", path),
			})
			continue
		}
		if n, exists := g.Nodes[cap.ID]; exists {
			n.Selected = true
			n.ReasonChain = nil
			continue
		}
		g.Nodes[cap.ID] = &Node{Cap: cap, Selected: true}
	}

	closeDependencies(g, cat, m, ds)
	substituteUpgrades(g, cat, m, ds)
	detectConflicts(g, m, ds)

	g.Order = topoSort(g)
	return g, ds
}

// closeDependencies walks requires edges to a fixed point, recording why each
// addition happened so the plan can explain it.
func closeDependencies(g *Graph, cat *catalog.Catalog, m *manifest.Manifest, ds *diag.Set) {
	for changed := true; changed; {
		changed = false
		for _, id := range sortedKeys(g.Nodes) {
			node := g.Nodes[id]
			for _, req := range node.Cap.Requires {
				if _, ok := g.Nodes[req.ID]; ok {
					continue
				}
				dep, ok := cat.Get(req.ID)
				if !ok {
					ds.Errorf("FORGE003", node.Cap.SourceFile, "requires",
						fmt.Sprintf("add %s to the catalog, or remove the requires edge", req.ID),
						"%s requires %q, which is not in the catalog", node.Cap.ID, req.ID)
					continue
				}
				chain := append(append([]string{}, node.ReasonChain...), node.Cap.ID)
				g.Nodes[dep.ID] = &Node{Cap: dep, ReasonChain: chain, Reason: req.Reason}
				changed = true
			}
		}
	}
	_ = m
}

// substituteUpgrades marks each upgraded capability as superseded. An upgrade
// takes over the slot: the upgraded capability's exposed interface survives so
// no consumer changes, but its implementation is replaced.
func substituteUpgrades(g *Graph, cat *catalog.Catalog, m *manifest.Manifest, ds *diag.Set) {
	// slot -> the upgrade occupying it
	claimed := map[string]string{}

	for _, id := range sortedKeys(g.Nodes) {
		node := g.Nodes[id]
		up := node.Cap.Upgrades
		if up == nil {
			continue
		}
		target, ok := g.Nodes[up.ID]
		if !ok {
			// Upgrading something not in the graph is inert, not an error: the
			// capability simply provides its own implementation.
			continue
		}
		if prior, taken := claimed[up.ID]; taken {
			ds.Errorf("FORGE005", m.SourceFile, "capabilities",
				fmt.Sprintf("remove %s or %s from the manifest; two capabilities cannot occupy one upgrade slot", prior, node.Cap.ID),
				"%s and %s both upgrade %s", prior, node.Cap.ID, up.ID)
			continue
		}
		claimed[up.ID] = node.Cap.ID
		target.SupersededBy = node.Cap.ID

		checkInterfaceSatisfaction(node.Cap, target.Cap, ds)
	}
	_ = cat
}

// checkInterfaceSatisfaction enforces the rule that makes upgrades safe: an
// upgrade must satisfy the full exposed interface of what it replaces.
// Without it, enabling Fine-Grained Permissions would silently break every
// capability that called can().
func checkInterfaceSatisfaction(upgrader, upgraded *spec.Capability, ds *diag.Set) {
	exempt := map[string]bool{}
	if upgrader.Upgrades != nil {
		for _, e := range upgrader.Upgrades.InterfaceExceptions {
			exempt[e] = true
		}
	}
	provided := map[string]bool{}
	for _, e := range upgrader.Exposes {
		provided[e.Kind+":"+e.Name] = true
	}
	for _, e := range upgraded.Exposes {
		if e.Kind == "registry" {
			continue // registries are contributed to, not reimplemented
		}
		key := e.Kind + ":" + e.Name
		if provided[key] || exempt[e.Name] {
			continue
		}
		ds.Errorf("FORGE006", upgrader.SourceFile, "exposes",
			fmt.Sprintf("expose %q on %s, or declare it in upgrades.interface_exceptions with a documented reason",
				e.Name, upgrader.ID),
			"%s upgrades %s but does not expose %q (%s), which %s consumers call",
			upgrader.ID, upgraded.ID, e.Name, e.Kind, upgraded.ID)
	}
}

// detectConflicts fails loudly at validate, never at apply.
func detectConflicts(g *Graph, m *manifest.Manifest, ds *diag.Set) {
	seen := map[string]bool{}
	for _, id := range sortedKeys(g.Nodes) {
		for _, c := range g.Nodes[id].Cap.Conflicts {
			if !g.Has(c.ID) {
				continue
			}
			// Report each pair once, whichever side declared it.
			key := id + "|" + c.ID
			rev := c.ID + "|" + id
			if seen[key] || seen[rev] {
				continue
			}
			seen[key] = true
			ds.Errorf("FORGE004", m.SourceFile, "capabilities",
				fmt.Sprintf("remove %s or %s from the manifest", id, c.ID),
				"%s conflicts with %s: %s", id, c.ID, c.Reason)
		}
	}
}

// topoSort orders dependencies before dependents, breaking ties by id so the
// result is byte-stable across runs. Any nondeterminism here would surface as
// spurious diffs in plan output.
func topoSort(g *Graph) []string {
	visited := map[string]int{} // 0 unseen, 1 in progress, 2 done
	var order []string

	var visit func(id string)
	visit = func(id string) {
		switch visited[id] {
		case 2:
			return
		case 1:
			// A requires cycle. The graph is still usable and the cycle is
			// reported by validation, so break rather than recurse forever.
			return
		}
		visited[id] = 1
		node := g.Nodes[id]
		deps := make([]string, 0, len(node.Cap.Requires))
		for _, r := range node.Cap.Requires {
			if g.Has(r.ID) {
				deps = append(deps, r.ID)
			}
		}
		sort.Strings(deps)
		for _, d := range deps {
			visit(d)
		}
		visited[id] = 2
		order = append(order, id)
	}

	for _, id := range sortedKeys(g.Nodes) {
		visit(id)
	}
	return order
}

func sortedKeys(m map[string]*Node) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ReasonString renders a dependency chain for plan output, e.g.
// "pay.invoices -> docs.generation -> data.files".
func (n *Node) ReasonString() string {
	if len(n.ReasonChain) == 0 {
		return ""
	}
	return strings.Join(append(append([]string{}, n.ReasonChain...), n.Cap.ID), " -> ")
}
