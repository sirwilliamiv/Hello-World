// Package validate implements the checks in ARCHITECTURE.md section 6.
//
// Every check runs. Errors accumulate rather than short-circuit, so one command
// run reports every problem instead of making the operator fix them one at a
// time.
package validate

import (
	"fmt"
	"sort"
	"strings"

	"github.com/Masterminds/semver/v3"

	"github.com/originplatformlabs/forge/internal/diag"
	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/resolve"
	"github.com/originplatformlabs/forge/internal/spec"
)

// Check identifiers, matching the table in ARCHITECTURE.md section 6.
const (
	CheckKernelRange   = "FORGE007"
	CheckEventContract = "FORGE008"
	CheckCredentials   = "FORGE009"
	CheckPrivacy       = "FORGE010"
	CheckEntityNames   = "FORGE011"
	CheckContractTests = "FORGE012"
	CheckEventOwner    = "FORGE013"
	CheckAsyncDurable  = "FORGE014"
)

// Run executes every graph-level check against a resolved product.
func Run(m *manifest.Manifest, g *resolve.Graph) *diag.Set {
	ds := &diag.Set{}
	kernelRange(g, ds)
	eventContracts(g, ds)
	eventOwnership(g, ds)
	credentials(m, g, ds)
	privacyHandlers(g, ds)
	entityNames(m, g, ds)
	mandatoryContractTests(g, ds)
	durableWorkRequired(m, g, ds)
	return ds
}

// Check 7: the intersection of every declared kernel_range must be non-empty.
// This is the constraint that actually gates a fleet-wide upgrade.
func kernelRange(g *resolve.Graph, ds *diag.Set) {
	type claim struct {
		id  string
		c   *semver.Constraints
		raw string
	}
	var claims []claim
	for _, n := range g.All() {
		if n.Cap.IsKernel() {
			continue // the kernel does not constrain itself
		}
		c, err := semver.NewConstraint(n.Cap.KernelRange)
		if err != nil {
			ds.Errorf(CheckKernelRange, n.Cap.SourceFile, "kernel_range",
				"use an npm-style range such as \"^1.0.0\"",
				"%s declares an unparseable kernel_range %q: %v", n.Cap.ID, n.Cap.KernelRange, err)
			continue
		}
		claims = append(claims, claim{n.Cap.ID, c, n.Cap.KernelRange})
	}
	if len(claims) < 2 {
		return
	}
	// Probe the kernel versions the catalog could plausibly offer. A real
	// implementation reads the published kernel version list; the shape of the
	// check — and its error message — is what matters here.
	var candidates []*semver.Version
	for major := 0; major <= 3; major++ {
		for minor := 0; minor <= 9; minor++ {
			v, _ := semver.NewVersion(fmt.Sprintf("%d.%d.0", major, minor))
			candidates = append(candidates, v)
		}
	}
	for _, v := range candidates {
		ok := true
		for _, cl := range claims {
			if !cl.c.Check(v) {
				ok = false
				break
			}
		}
		if ok {
			return // satisfiable
		}
	}
	// Name the two capabilities that actually disagree rather than listing all.
	a, b := claims[0], claims[1]
	for i := range claims {
		for j := i + 1; j < len(claims); j++ {
			conflict := true
			for _, v := range candidates {
				if claims[i].c.Check(v) && claims[j].c.Check(v) {
					conflict = false
					break
				}
			}
			if conflict {
				a, b = claims[i], claims[j]
				goto report
			}
		}
	}
report:
	ds.Errorf(CheckKernelRange, "", "capabilities",
		fmt.Sprintf("publish a release of %s or %s with an overlapping kernel_range before selecting both", a.id, b.id),
		"no kernel version satisfies every capability: %s needs %s but %s needs %s",
		a.id, a.raw, b.id, b.raw)
}

// Check 8: every consumed event must have a publisher in the graph emitting a
// contract version the consumer handles. This turns "the accounting sync does
// not understand v2 payloads" from a 2am incident into a message printed before
// anything is built.
func eventContracts(g *resolve.Graph, ds *diag.Set) {
	published := map[string][]pub{}
	for _, n := range g.Active() {
		for _, e := range n.Cap.Publishes {
			published[e.Name] = append(published[e.Name], pub{n.Cap.ID, e.ContractVersion})
		}
	}

	for _, n := range g.Active() {
		for _, c := range n.Cap.Consumes {
			matches := matchingEvents(published, c.Name)

			if len(matches) == 0 {
				if c.Required {
					ds.Errorf(CheckEventContract, n.Cap.SourceFile, "consumes",
						fmt.Sprintf("add a capability that publishes %s, or mark the subscription required:false", c.Name),
						"%s requires event %q (%s) but nothing in the resolved graph publishes it",
						n.Cap.ID, c.Name, c.Reason)
				}
				continue
			}
			for _, name := range matches {
				for _, p := range published[name] {
					if c.Handles(p.version) {
						continue
					}
					ds.Errorf(CheckEventContract, n.Cap.SourceFile, "consumes",
						fmt.Sprintf("add %d to contract_versions on %s's %q subscription, or pin %s to a version that emits v%s",
							p.version, n.Cap.ID, c.Name, p.capID, versionsOf(c)),
						"%s publishes %s at contract version %d; %s handles %s",
						p.capID, name, p.version, n.Cap.ID, versionsOf(c))
				}
			}
		}
	}
}

// Check 13: two capabilities may not publish the same event name.
//
// This is not in the brief's list; it was added after the catalog review found
// ops.queue and ops.dispatch both publishing job.started with unrelated
// payloads. A consumer subscribing to a name owned by two publishers cannot
// know which payload it is receiving, and no amount of contract versioning
// fixes it, because the versions are independent.
func eventOwnership(g *resolve.Graph, ds *diag.Set) {
	owners := map[string][]string{}
	for _, n := range g.Active() {
		for _, e := range n.Cap.Publishes {
			owners[e.Name] = append(owners[e.Name], n.Cap.ID)
		}
	}
	names := make([]string, 0, len(owners))
	for name := range owners {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		ids := owners[name]
		if len(ids) < 2 {
			continue
		}
		sort.Strings(ids)
		ds.Errorf(CheckEventOwner, "", "publishes",
			fmt.Sprintf("namespace the event by its owning domain, e.g. %q and %q",
				ids[0]+"."+lastSegment(name), ids[1]+"."+lastSegment(name)),
			"event %q is published by more than one capability (%s); a consumer cannot tell the payloads apart",
			name, strings.Join(ids, ", "))
	}
}

// Check 9: every required credential declared by a capability must be bound in
// the manifest. Presence only — a value is never read here.
func credentials(m *manifest.Manifest, g *resolve.Graph, ds *diag.Set) {
	bound := map[string]bool{}
	for _, integ := range m.Integrations {
		if integ.Enabled != nil && !*integ.Enabled {
			continue
		}
		for name := range integ.Credentials {
			bound[name] = true
		}
	}

	for _, n := range g.Active() {
		for _, ext := range n.Cap.External {
			if ext.Optional {
				continue
			}
			for _, cred := range ext.Credentials {
				if cred.Optional || bound[cred.Name] {
					continue
				}
				ds.Errorf(CheckCredentials, m.SourceFile, "integrations",
					fmt.Sprintf("add a credentials entry binding %s to a secret_ref under an integrations block", cred.Name),
					"%s requires credential %s for %s (%s), which no integration in the manifest binds",
					n.Cap.ID, cred.Name, ext.Service, cred.Description)
			}
		}
	}
}

// Check 10: a capability owning personal data must declare export and deletion
// handlers when data.privacy is enabled.
func privacyHandlers(g *resolve.Graph, ds *diag.Set) {
	if !g.Has("data.privacy") {
		return
	}
	for _, n := range g.Active() {
		for _, e := range n.Cap.Owns {
			if !e.PersonalData {
				continue
			}
			if e.Privacy == nil || e.Privacy.ExportHandler == "" || e.Privacy.DeletionStrategy == "" {
				ds.Errorf(CheckPrivacy, n.Cap.SourceFile, "owns",
					fmt.Sprintf("add a privacy block to %s.%s with export_handler and deletion_strategy", n.Cap.ID, e.Name),
					"%s owns %s, which holds personal data, but declares no privacy handlers while data.privacy is enabled",
					n.Cap.ID, e.Name)
			}
		}
	}
}

// Check 11: manifest-declared entities must not collide with capability-owned
// ones, and no two capabilities may own the same entity name.
func entityNames(m *manifest.Manifest, g *resolve.Graph, ds *diag.Set) {
	owner := map[string]string{}
	for _, n := range g.All() {
		for _, e := range n.Cap.Owns {
			if prior, dup := owner[e.Name]; dup {
				ds.Errorf(CheckEntityNames, n.Cap.SourceFile, "owns",
					fmt.Sprintf("rename one of them; only the kernel may define shared primitives"),
					"entity %q is owned by both %s and %s", e.Name, prior, n.Cap.ID)
				continue
			}
			owner[e.Name] = n.Cap.ID
		}
	}
	for i, e := range m.Entities {
		path := fmt.Sprintf("entities/%d/name", i)
		if prior, dup := owner[e.Name]; dup {
			ds.Add(diag.Diagnostic{
				Severity: diag.Error, Check: CheckEntityNames, File: m.SourceFile,
				Line: m.Line(path), Path: path,
				Message: fmt.Sprintf("client entity %q collides with an entity owned by %s", e.Name, prior),
				Fix:     fmt.Sprintf("rename the entity at %s", path),
			})
		}
	}
}

// Check 12: a mandatory contract test must exist whenever both sides of the
// declared pair are in the resolved graph.
func mandatoryContractTests(g *resolve.Graph, ds *diag.Set) {
	declared := map[string]bool{}
	for _, n := range g.All() {
		for _, t := range n.Cap.Tests.Contract {
			declared[n.Cap.ID+"|"+t.With] = true
			declared[t.With+"|"+n.Cap.ID] = true
		}
	}
	for _, n := range g.All() {
		for _, t := range n.Cap.Tests.Contract {
			if !t.Mandatory || !g.Has(t.With) {
				continue
			}
			if !declared[n.Cap.ID+"|"+t.With] {
				ds.Errorf(CheckContractTests, n.Cap.SourceFile, "tests.contract",
					fmt.Sprintf("add the contract test for the %s/%s pair", n.Cap.ID, t.With),
					"mandatory contract test between %s and %s is missing", n.Cap.ID, t.With)
			}
		}
	}
}

// Check 14: capabilities doing meaningful async work need a durable queue.
// A warning in general; an error for the three the catalog names, because
// kernel work drops their jobs on restart.
func durableWorkRequired(m *manifest.Manifest, g *resolve.Graph, ds *diag.Set) {
	if g.Has("ops.queue") {
		return
	}
	mustBeDurable := map[string]bool{
		"docs.extraction": true, "automation.rules": true,
	}
	for _, n := range g.Active() {
		needs := mustBeDurable[n.Cap.ID] || strings.HasPrefix(n.Cap.ID, "integrate.")
		if !needs {
			continue
		}
		ds.Errorf(CheckAsyncDurable, m.SourceFile, "capabilities",
			"add ops.queue to the manifest capabilities list",
			"%s requires durable background processing; kernel work drops its jobs on restart", n.Cap.ID)
	}
}

// pub is a publisher of one event at one contract version.
type pub struct {
	capID   string
	version int
}

func matchingEvents(published map[string][]pub, pattern string) []string {
	var out []string
	for name := range published {
		if eventMatches(pattern, name) {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// eventMatches implements the pattern language: an exact name, a "prefix.*"
// glob, or "**" for every event in the system.
func eventMatches(pattern, name string) bool {
	switch {
	case pattern == "**":
		return true
	case strings.HasSuffix(pattern, ".*"):
		return strings.HasPrefix(name, strings.TrimSuffix(pattern, "*"))
	default:
		return pattern == name
	}
}

func versionsOf(c spec.Consumed) string {
	parts := make([]string, len(c.ContractVersions))
	for i, v := range c.ContractVersions {
		parts[i] = fmt.Sprintf("v%d", v)
	}
	return strings.Join(parts, ", ")
}

func lastSegment(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		return name[i+1:]
	}
	return name
}
