package main

import (
	"strings"

	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/resolve"
	"github.com/originplatformlabs/forge/internal/spec"
)

// quote is a priced proposal derived from the resolved graph.
//
// The integration premium is COUNTED, not estimated: it falls out of the
// declared relationships that are actually realised in this product. That is
// what makes the commercial model a direct output of the technical one, and it
// is why the breakdown is printed rather than just the total — a buyer can be
// shown exactly what they are paying for.
type quote struct {
	lines              []quoteLine
	currency           string
	capabilitySubtotal int
	baseWeight         int
	eventPairs         int
	enhancesUnits      int
	contractUnits      int
	totalWeight        int
	rate               int
	premium            int
	discount           int
	total              int
	quotedPresent      bool
}

type quoteLine struct {
	id     string
	name   string
	amount int
}

func computeQuote(m *manifest.Manifest, g *resolve.Graph) quote {
	q := quote{currency: "USD"}
	if m.Commercial != nil {
		if m.Commercial.Currency != "" {
			q.currency = m.Commercial.Currency
		}
		q.rate = m.Commercial.IntegrationRateMinor
		q.discount = m.Commercial.DiscountMinor
	}

	active := g.Active()

	for _, n := range active {
		switch n.Cap.Price.Model {
		case "included":
			continue
		case "quoted":
			q.quotedPresent = true
			q.lines = append(q.lines, quoteLine{n.Cap.ID, n.Cap.Name + " (quoted)", 0})
			continue
		}
		q.lines = append(q.lines, quoteLine{n.Cap.ID, n.Cap.Name, n.Cap.Price.AmountMinor})
		q.capabilitySubtotal += n.Cap.Price.AmountMinor
		// A quoted capability contributes no computed weight: its relationships
		// are by definition not yet declared, so counting them would produce a
		// number with the appearance of derivation and none of the substance.
		q.baseWeight += n.Cap.IntegrationWeight
	}

	q.eventPairs = countEventPairs(active)
	q.enhancesUnits = 2 * countRealisedEnhances(g, active)
	q.contractUnits = 3 * countMandatoryContractPairs(g, active)

	q.totalWeight = q.baseWeight + q.eventPairs + q.enhancesUnits + q.contractUnits
	q.premium = q.totalWeight * q.rate
	q.total = q.capabilitySubtotal + q.premium + q.discount
	return q
}

// countEventPairs counts realised *subscriptions*, not matching events.
//
// The premium is meant to price connective work. A capability declaring
// `consumes: "**"` wired up one subscription, not one per event in the system,
// so a wildcard counts once no matter how many publishers it matches. Counting
// per matching event inflated a five-capability product to 56 units, which is
// the sort of number that discredits a computed premium in front of a buyer.
//
// Kernel consumers are excluded: the kernel is present in every product, so its
// internal wiring is baseline rather than integration work bought by this client.
func countEventPairs(active []*resolve.Node) int {
	type pubRef struct{ cap, event string }
	var published []pubRef
	for _, n := range active {
		for _, e := range n.Cap.Publishes {
			published = append(published, pubRef{n.Cap.ID, e.Name})
		}
	}
	count := 0
	for _, n := range active {
		if n.Cap.IsKernel() {
			continue
		}
		for _, c := range n.Cap.Consumes {
			realised := false
			for _, p := range published {
				if p.cap != n.Cap.ID && eventMatches(c.Name, p.event) {
					realised = true
					break
				}
			}
			if realised {
				count++
			}
		}
	}
	return count
}

// countRealisedEnhances counts enhances edges whose other side is present.
// Selector targets are expanded against the resolved graph, which is what makes
// "enhances every capability that owns personal data" a countable relationship
// rather than prose in a document.
func countRealisedEnhances(g *resolve.Graph, active []*resolve.Node) int {
	count := 0
	for _, n := range active {
		if n.Cap.IsKernel() {
			continue // baseline, not client-specific integration work
		}
		for _, e := range n.Cap.Enhances {
			for _, other := range active {
				if other.Cap.ID == n.Cap.ID {
					continue
				}
				if selectorMatches(e.Target, other.Cap) {
					count++
				}
			}
		}
	}
	_ = g
	return count
}

func countMandatoryContractPairs(g *resolve.Graph, active []*resolve.Node) int {
	seen := map[string]bool{}
	count := 0
	for _, n := range active {
		for _, t := range n.Cap.Tests.Contract {
			if !t.Mandatory || !g.Has(t.With) {
				continue
			}
			a, b := n.Cap.ID, t.With
			if a > b {
				a, b = b, a
			}
			key := a + "|" + b
			if seen[key] {
				continue
			}
			seen[key] = true
			count++
		}
	}
	return count
}

// selectorMatches evaluates a relationship target: a concrete id, a namespace
// glob, or one of the closed set of derived selectors.
func selectorMatches(target string, c *spec.Capability) bool {
	switch target {
	case "all":
		return true
	case "owns_data":
		return hasEntity(c, func(e spec.Entity) bool { return e.Kind == "table" })
	case "owns_personal_data":
		return hasEntity(c, func(e spec.Entity) bool { return e.PersonalData })
	case "owns_listable_data":
		return hasEntity(c, func(e spec.Entity) bool { return e.Listable == nil || *e.Listable })
	case "owns_tenant_scoped_data":
		return hasEntity(c, func(e spec.Entity) bool { return e.Kind == "table" && e.IsTenantScoped() })
	case "has_protected_resources":
		for _, s := range c.Surfaces {
			if s.Permission != "" {
				return true
			}
		}
		return false
	case "performs_async_work":
		for _, r := range c.Requires {
			if r.ID == "kernel.work" || r.ID == "ops.queue" {
				return true
			}
		}
		return false
	case "notifies_humans":
		for _, r := range c.Requires {
			if strings.HasPrefix(r.ID, "comms.") || r.ID == "kernel.mail" {
				return true
			}
		}
		return false
	case "publishes_events":
		return len(c.Publishes) > 0
	}
	if strings.HasSuffix(target, ".*") {
		return strings.HasPrefix(c.ID, strings.TrimSuffix(target, "*"))
	}
	return target == c.ID
}

func hasEntity(c *spec.Capability, pred func(spec.Entity) bool) bool {
	for _, e := range c.Owns {
		if pred(e) {
			return true
		}
	}
	return false
}

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
