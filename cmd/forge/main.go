// Command forge composes client products from versioned capabilities.
//
// Phase 1 implements the read-only half of the command surface: validate,
// catalog, and graph. Nothing here mutates anything — plan and apply arrive
// with the codegen provider.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/originplatformlabs/forge/internal/catalog"
	"github.com/originplatformlabs/forge/internal/diag"
	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/resolve"
	"github.com/originplatformlabs/forge/internal/spec"
	"github.com/originplatformlabs/forge/internal/validate"
)

const usage = `forge — compose client products from versioned capabilities

Usage:
  forge validate [-f forge.yaml]    schema, graph, conflict, and credential checks
  forge catalog                     browse the capability catalog
  forge catalog show <id>           full specification including all interactions
  forge graph [-f forge.yaml]       render the resolved dependency graph
  forge quote [-f forge.yaml]       priced proposal computed from the manifest

Flags:
  -f, --file    manifest path (default forge.yaml)
  -C, --root    repository root holding catalog/ and schemas/ (default .)

Every command in this list is read-only.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd := os.Args[1]
	args := os.Args[2:]

	var code int
	switch cmd {
	case "validate":
		code = cmdValidate(args)
	case "catalog":
		code = cmdCatalog(args)
	case "graph":
		code = cmdGraph(args)
	case "quote":
		code = cmdQuote(args)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		code = 2
	}
	os.Exit(code)
}

type commonFlags struct {
	file string
	root string
}

func parseCommon(fs *flag.FlagSet, args []string) *commonFlags {
	c := &commonFlags{}
	fs.StringVar(&c.file, "f", "forge.yaml", "manifest path")
	fs.StringVar(&c.file, "file", "forge.yaml", "manifest path")
	fs.StringVar(&c.root, "C", ".", "repository root")
	fs.StringVar(&c.root, "root", ".", "repository root")
	_ = fs.Parse(args)
	return c
}

func (c *commonFlags) catalogDir() string { return filepath.Join(c.root, "catalog") }
func (c *commonFlags) capSchema() string {
	return filepath.Join(c.root, "schemas", "capability.schema.json")
}
func (c *commonFlags) manSchema() string {
	return filepath.Join(c.root, "schemas", "manifest.schema.json")
}

// loadAll runs the pipeline through validation, returning everything a command
// needs plus the accumulated diagnostics.
func loadAll(c *commonFlags) (*manifest.Manifest, *catalog.Catalog, *resolve.Graph, *diag.Set, error) {
	all := &diag.Set{}

	cat, cds, err := catalog.Load(c.catalogDir(), c.capSchema())
	if err != nil {
		return nil, nil, nil, all, err
	}
	for _, d := range cds.Items() {
		all.Add(d)
	}

	m, mds, err := manifest.Load(c.file, c.manSchema())
	if err != nil {
		return nil, cat, nil, all, err
	}
	for _, d := range mds.Items() {
		all.Add(d)
	}
	if m == nil {
		return nil, cat, nil, all, nil
	}

	g, rds := resolve.Resolve(m, cat)
	for _, d := range rds.Items() {
		all.Add(d)
	}
	for _, d := range validate.Run(m, g).Items() {
		all.Add(d)
	}
	return m, cat, g, all, nil
}

func report(ds *diag.Set) int {
	items := ds.Sorted()
	for _, d := range items {
		fmt.Fprintln(os.Stderr, d)
		fmt.Fprintln(os.Stderr)
	}
	errs, warns := ds.Count()
	switch {
	case errs > 0:
		fmt.Fprintf(os.Stderr, "%d error(s), %d warning(s)\n", errs, warns)
		return 1
	case warns > 0:
		fmt.Fprintf(os.Stderr, "%d warning(s)\n", warns)
	}
	return 0
}

func cmdValidate(args []string) int {
	c := parseCommon(flag.NewFlagSet("validate", flag.ContinueOnError), args)
	m, cat, g, ds, err := loadAll(c)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	if code := report(ds); code != 0 {
		return code
	}
	if m == nil || g == nil {
		return 1
	}
	fmt.Printf("%s: valid\n", m.Product.Name)
	fmt.Printf("  catalog snapshot   %s (%d capabilities available)\n", m.Catalog.Snapshot, cat.Len())
	fmt.Printf("  selected           %d\n", countSelected(g))
	fmt.Printf("  resolved           %d capabilities, %d superseded\n", len(g.Active()), countSuperseded(g))
	fmt.Printf("  client entities    %d\n", len(m.Entities))
	fmt.Printf("  environments       %s\n", strings.Join(sortedEnvNames(m), ", "))
	return 0
}

func cmdGraph(args []string) int {
	c := parseCommon(flag.NewFlagSet("graph", flag.ContinueOnError), args)
	m, _, g, ds, err := loadAll(c)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	if m == nil || g == nil {
		return report(ds)
	}

	fmt.Printf("Resolved graph for %s (snapshot %s)\n\n", m.Product.Name, m.Catalog.Snapshot)

	fmt.Println("KERNEL — mandatory and implicit")
	for _, n := range g.All() {
		if !n.Cap.IsKernel() {
			continue
		}
		mark := "  "
		note := ""
		if n.Superseded() {
			mark = "~ "
			note = fmt.Sprintf("  superseded by %s", n.SupersededBy)
		}
		fmt.Printf("%s%-24s %s%s\n", mark, n.Cap.ID, n.Cap.Name, note)
	}

	fmt.Println("\nSELECTED — named in the manifest")
	for _, n := range g.All() {
		if n.Cap.IsKernel() || !n.Selected {
			continue
		}
		fmt.Printf("  %-24s %s  %s\n", n.Cap.ID, n.Cap.Name, price(n))
	}

	added := false
	for _, n := range g.All() {
		if n.Cap.IsKernel() || n.Selected {
			continue
		}
		if !added {
			fmt.Println("\nRESOLVED — added automatically, with the chain that pulled them in")
			added = true
		}
		fmt.Printf("  %-24s %s  %s\n", n.Cap.ID, n.Cap.Name, price(n))
		fmt.Printf("  %-24s   via %s\n", "", n.ReasonString())
		if n.Reason != "" {
			fmt.Printf("  %-24s   %s\n", "", n.Reason)
		}
	}

	fmt.Println("\nAPPLY ORDER — dependencies first, ties broken by id")
	for i, id := range g.Order {
		fmt.Printf("  %2d. %s\n", i+1, id)
	}

	fmt.Println()
	return report(ds)
}

func cmdCatalog(args []string) int {
	if len(args) >= 2 && args[0] == "show" {
		return cmdCatalogShow(args[1], args[2:])
	}
	c := parseCommon(flag.NewFlagSet("catalog", flag.ContinueOnError), args)
	cat, ds, err := catalog.Load(c.catalogDir(), c.capSchema())
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	if ds.HasErrors() {
		return report(ds)
	}

	fmt.Print("KERNEL — present in every product, never listed in a manifest\n\n")
	for _, cap := range cat.Kernel() {
		fmt.Printf("  %-22s %s\n", cap.ID, cap.Name)
	}

	byNamespace := map[string][]string{}
	for _, cap := range cat.Selectable() {
		ns := strings.SplitN(cap.ID, ".", 2)[0]
		byNamespace[ns] = append(byNamespace[ns],
			fmt.Sprintf("  %-22s %-34s %10s  weight %d", cap.ID, cap.Name, priceString(cap.Price), cap.IntegrationWeight))
	}
	namespaces := make([]string, 0, len(byNamespace))
	for ns := range byNamespace {
		namespaces = append(namespaces, ns)
	}
	sort.Strings(namespaces)

	fmt.Print("\nCAPABILITIES\n\n")
	for _, ns := range namespaces {
		fmt.Printf("  [%s]\n", ns)
		for _, line := range byNamespace[ns] {
			fmt.Println(line)
		}
		fmt.Println()
	}
	fmt.Printf("%d capabilities (%d kernel, %d selectable)\n",
		cat.Len(), len(cat.Kernel()), len(cat.Selectable()))
	return report(ds)
}

func cmdCatalogShow(id string, args []string) int {
	c := parseCommon(flag.NewFlagSet("catalog show", flag.ContinueOnError), args)
	cat, ds, err := catalog.Load(c.catalogDir(), c.capSchema())
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	if ds.HasErrors() {
		return report(ds)
	}
	cap, ok := cat.Get(id)
	if !ok {
		fmt.Fprintf(os.Stderr, "error: no capability %q in the catalog\n", id)
		fmt.Fprintln(os.Stderr, "fix: run `forge catalog` to list what is available")
		return 1
	}

	fmt.Printf("%s  %s@%s\n", cap.Name, cap.ID, cap.Version)
	fmt.Printf("%s\n\n", strings.Repeat("=", 60))
	if cap.Trigger != "" {
		fmt.Printf("  %s\n\n", cap.Trigger)
	}
	fmt.Printf("  tier         %s\n", cap.Tier)
	fmt.Printf("  price        %s\n", priceString(cap.Price))
	fmt.Printf("  weight       %d\n", cap.IntegrationWeight)
	fmt.Printf("  kernel       %s\n", cap.KernelRange)
	if cap.Package != nil {
		fmt.Printf("  package      %s\n", cap.Package.Name)
	}
	if cap.Summary != "" {
		fmt.Printf("\n  %s\n", wrap(cap.Summary, 72, "  "))
	}

	section("REQUIRES", len(cap.Requires) > 0, func() {
		for _, r := range cap.Requires {
			fmt.Printf("  %-24s %s\n", r.ID+" "+r.Range, r.Reason)
		}
	})
	section("ENHANCES", len(cap.Enhances) > 0, func() {
		for _, e := range cap.Enhances {
			fmt.Printf("  %-24s %s\n", e.Target, e.Unlocks)
		}
	})
	if cap.Upgrades != nil {
		section("UPGRADES", true, func() {
			fmt.Printf("  %-24s migration %s\n", cap.Upgrades.ID, cap.Upgrades.Migration)
		})
	}
	section("CONFLICTS", len(cap.Conflicts) > 0, func() {
		for _, c := range cap.Conflicts {
			fmt.Printf("  %-24s %s\n", c.ID, c.Reason)
		}
	})
	section("OWNS", len(cap.Owns) > 0, func() {
		for _, e := range cap.Owns {
			flags := []string{e.Kind}
			if e.PersonalData {
				flags = append(flags, "personal-data")
			}
			if e.AppendOnly {
				flags = append(flags, "append-only")
			}
			if !e.IsTenantScoped() {
				flags = append(flags, "global")
			}
			fmt.Printf("  %-24s %s\n", e.Name, strings.Join(flags, ", "))
		}
	})
	section("PUBLISHES", len(cap.Publishes) > 0, func() {
		for _, e := range cap.Publishes {
			suffix := ""
			if e.PerEntity {
				suffix = "  (per entity)"
			}
			fmt.Printf("  %-38s contract v%d%s\n", e.Name, e.ContractVersion, suffix)
		}
	})
	section("CONSUMES", len(cap.Consumes) > 0, func() {
		for _, e := range cap.Consumes {
			req := "optional"
			if e.Required {
				req = "required"
			}
			fmt.Printf("  %-38s %-9s %s\n", e.Name, req, e.Reason)
		}
	})
	section("EXPOSES", len(cap.Exposes) > 0, func() {
		for _, e := range cap.Exposes {
			extra := ""
			if e.AgentCallable {
				extra = fmt.Sprintf("  [agent-callable: %s]", e.Consequence)
			}
			target := e.Signature
			if target == "" {
				target = e.Path
			}
			fmt.Printf("  %-12s %-24s %s%s\n", e.Kind, e.Name, target, extra)
		}
	})
	section("SLOTS", len(cap.Slots) > 0, func() {
		for _, s := range cap.Slots {
			fmt.Printf("  %-24s %s\n", s.Name, s.Description)
		}
	})
	section("EXTERNAL", len(cap.External) > 0, func() {
		for _, x := range cap.External {
			fmt.Printf("  %-24s %s\n", x.Service, x.Purpose)
			for _, cr := range x.Credentials {
				fmt.Printf("    %-22s %s\n", cr.Name, cr.Description)
			}
		}
	})
	section("CONTRACT TESTS", len(cap.Tests.Contract) > 0, func() {
		for _, t := range cap.Tests.Contract {
			mark := " "
			if t.Mandatory {
				mark = "!"
			}
			fmt.Printf(" %s %-20s %s\n", mark, t.With, t.Scenario)
			fmt.Printf("   %-20s   %s\n", "", t.Asserts)
		}
	})
	fmt.Printf("\nspecification: %s\n", cap.SourceFile)
	return 0
}

func cmdQuote(args []string) int {
	c := parseCommon(flag.NewFlagSet("quote", flag.ContinueOnError), args)
	m, _, g, ds, err := loadAll(c)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	if ds.HasErrors() {
		return report(ds)
	}
	if m == nil || g == nil {
		return 1
	}

	q := computeQuote(m, g)
	if q.quotedPresent {
		fmt.Fprintln(os.Stderr, "error: the resolved graph contains a quoted capability with no manual figure supplied")
		fmt.Fprintln(os.Stderr, "fix: price it per engagement and record it in commercial.notes; forge quote will not guess")
		return 1
	}

	fmt.Printf("Proposal — %s\n%s\n\n", m.Product.Client.Name, strings.Repeat("=", 60))
	fmt.Println("CAPABILITIES")
	for _, l := range q.lines {
		fmt.Printf("  %-24s %-32s %12s\n", l.id, l.name, money(l.amount, q.currency))
	}
	fmt.Printf("  %-24s %-32s %12s\n\n", "", "subtotal", money(q.capabilitySubtotal, q.currency))

	fmt.Println("SYSTEMS INTEGRATION — counted, not estimated")
	fmt.Printf("  %-40s %6d units\n", "base capability weight", q.baseWeight)
	fmt.Printf("  %-40s %6d units\n", "realised event publisher/consumer pairs", q.eventPairs)
	fmt.Printf("  %-40s %6d units\n", "realised enhances relationships (x2)", q.enhancesUnits)
	fmt.Printf("  %-40s %6d units\n", "mandatory contract test pairs (x3)", q.contractUnits)
	fmt.Printf("  %-40s %6d units @ %s\n", "total weight", q.totalWeight, money(q.rate, q.currency))
	fmt.Printf("  %-40s %13s\n\n", "integration premium", money(q.premium, q.currency))

	if q.discount != 0 {
		fmt.Printf("  %-40s %13s\n", "adjustment", money(q.discount, q.currency))
	}
	fmt.Printf("  %-40s %13s\n", "TOTAL", money(q.total, q.currency))
	if m.Commercial != nil && m.Commercial.Notes != "" {
		fmt.Printf("\n%s\n", strings.TrimSpace(m.Commercial.Notes))
	}
	return 0
}

func section(title string, present bool, body func()) {
	if !present {
		return
	}
	fmt.Printf("\n%s\n", title)
	body()
}

func countSelected(g *resolve.Graph) int {
	n := 0
	for _, node := range g.All() {
		if node.Selected {
			n++
		}
	}
	return n
}

func countSuperseded(g *resolve.Graph) int {
	n := 0
	for _, node := range g.All() {
		if node.Superseded() {
			n++
		}
	}
	return n
}

func sortedEnvNames(m *manifest.Manifest) []string {
	out := make([]string, 0, len(m.Environments))
	for k := range m.Environments {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func price(n *resolve.Node) string { return priceString(n.Cap.Price) }

func priceString(p spec.Price) string {
	switch p.Model {
	case "included":
		return "included"
	case "quoted":
		return "quoted"
	default:
		cur := p.Currency
		if cur == "" {
			cur = "USD"
		}
		return money(p.AmountMinor, cur)
	}
}

func money(minor int, currency string) string {
	sign := ""
	if minor < 0 {
		sign = "-"
		minor = -minor
	}
	symbol := "$"
	if currency != "USD" {
		symbol = currency + " "
	}
	return fmt.Sprintf("%s%s%s.%02d", sign, symbol, withCommas(minor/100), minor%100)
}

func withCommas(n int) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var out []byte
	for i, c := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, c)
	}
	return string(out)
}

func wrap(s string, width int, indent string) string {
	words := strings.Fields(s)
	var lines []string
	line := ""
	for _, w := range words {
		if line == "" {
			line = w
		} else if len(line)+1+len(w) <= width {
			line += " " + w
		} else {
			lines = append(lines, line)
			line = w
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n"+indent)
}
