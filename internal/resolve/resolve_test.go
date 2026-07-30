package resolve

import (
	"strings"
	"testing"

	"github.com/originplatformlabs/forge/internal/catalog"
	"github.com/originplatformlabs/forge/internal/diag"
	"github.com/originplatformlabs/forge/internal/manifest"
	"github.com/originplatformlabs/forge/internal/spec"
)

// Helpers for building small catalogs. Resolution is one of the parts the brief
// singles out as silently corrupting a client when wrong, so it is tested
// against constructed graphs rather than only against the real catalog.

func cap(id string, tier spec.Tier, requires ...string) *spec.Capability {
	c := &spec.Capability{
		SpecVersion: 1, ID: id, Version: "1.0.0", KernelRange: "^1.0.0",
		Name: id, Tier: tier, Price: spec.Price{Model: "fixed", AmountMinor: 100000},
	}
	if tier == spec.TierKernel {
		c.Price = spec.Price{Model: "included"}
	}
	for _, r := range requires {
		c.Requires = append(c.Requires, spec.Dependency{ID: r, Range: "^1.0.0", Reason: "needed by " + id})
	}
	return c
}

func mf(ids ...string) *manifest.Manifest {
	m := &manifest.Manifest{
		ManifestVersion: 1,
		Catalog:         manifest.CatalogPin{Snapshot: "2026-07-15"},
		Product:         manifest.Product{ID: "t", Name: "Test"},
		SourceFile:      "forge.yaml",
	}
	for _, id := range ids {
		m.Capabilities = append(m.Capabilities, manifest.Selection{ID: id})
	}
	return m
}

func TestKernelIsAlwaysPresentAndNeverSelectable(t *testing.T) {
	cat := catalog.New(cap("kernel.data", spec.TierKernel), cap("pay.card", spec.TierCapability))

	g, ds := Resolve(mf("pay.card"), cat)
	if !g.Has("kernel.data") {
		t.Fatal("kernel.data must be present without being listed in the manifest")
	}
	if ds.HasErrors() {
		t.Fatalf("unexpected errors: %v", ds.Items())
	}

	// Naming a kernel capability in a manifest is an error, not a no-op: it
	// signals a misunderstanding that would spread through every later manifest.
	_, ds2 := Resolve(mf("kernel.data"), cat)
	if !ds2.HasErrors() {
		t.Fatal("expected an error when a kernel capability is listed in the manifest")
	}
	if got := ds2.Items()[0].Check; got != "FORGE003" {
		t.Fatalf("check = %q, want FORGE003", got)
	}
}

func TestTransitiveClosureRecordsReasonChain(t *testing.T) {
	// pay.invoices -> docs.generation -> data.files -> ops.queue, the real
	// Phase 1 shape: three levels, none of which the manifest names.
	cat := catalog.New(
		cap("kernel.events", spec.TierKernel),
		cap("ops.queue", spec.TierCapability, "kernel.events"),
		cap("data.files", spec.TierCapability, "ops.queue"),
		cap("docs.generation", spec.TierCapability, "data.files"),
		cap("pay.invoices", spec.TierCapability, "docs.generation"),
	)

	g, ds := Resolve(mf("pay.invoices"), cat)
	if ds.HasErrors() {
		t.Fatalf("unexpected errors: %v", ds.Items())
	}

	for _, id := range []string{"docs.generation", "data.files", "ops.queue"} {
		if !g.Has(id) {
			t.Fatalf("%s should have been pulled in transitively", id)
		}
		if g.Nodes[id].Selected {
			t.Fatalf("%s was not named in the manifest and must not be marked selected", id)
		}
	}

	// The chain is what the plan prints so an addition is never a surprise.
	want := "pay.invoices -> docs.generation -> data.files -> ops.queue"
	if got := g.Nodes["ops.queue"].ReasonString(); got != want {
		t.Errorf("reason chain = %q, want %q", got, want)
	}
	if got := g.Nodes["ops.queue"].Reason; !strings.Contains(got, "data.files") {
		t.Errorf("reason = %q, want the declared justification from the requires edge", got)
	}
}

func TestSelectingADependencyDirectlyMarksItSelected(t *testing.T) {
	cat := catalog.New(
		cap("docs.generation", spec.TierCapability),
		cap("pay.invoices", spec.TierCapability, "docs.generation"),
	)
	g, _ := Resolve(mf("pay.invoices", "docs.generation"), cat)
	if !g.Nodes["docs.generation"].Selected {
		t.Error("a capability named in the manifest must be marked selected even when it is also a dependency")
	}
	if chain := g.Nodes["docs.generation"].ReasonString(); chain != "" {
		t.Errorf("a directly selected capability should carry no reason chain, got %q", chain)
	}
}

func TestUpgradeSupersedesTargetWithoutRemovingIt(t *testing.T) {
	work := cap("kernel.work", spec.TierKernel)
	work.Exposes = []spec.Exposed{
		{Kind: "interface", Name: "enqueue", Signature: "enqueue(j)"},
		{Kind: "interface", Name: "schedule", Signature: "schedule(c, j)"},
	}
	queue := cap("ops.queue", spec.TierUpgrade)
	queue.Upgrades = &spec.UpgradeTarget{ID: "kernel.work", Migration: "m1"}
	queue.Exposes = work.Exposes

	g, ds := Resolve(mf("ops.queue"), catalog.New(work, queue))
	if ds.HasErrors() {
		t.Fatalf("unexpected errors: %v", ds.Items())
	}
	// The upgraded capability stays in the graph: its exposed interface survives
	// so no consumer has to change. Only the implementation is replaced.
	if !g.Has("kernel.work") {
		t.Fatal("an upgraded capability must remain in the graph")
	}
	if !g.Nodes["kernel.work"].Superseded() {
		t.Fatal("kernel.work should be marked superseded")
	}
	if got := g.Nodes["kernel.work"].SupersededBy; got != "ops.queue" {
		t.Errorf("SupersededBy = %q, want ops.queue", got)
	}
	for _, n := range g.Active() {
		if n.Cap.ID == "kernel.work" {
			t.Error("a superseded capability must not appear in Active()")
		}
	}
}

func TestUpgradeMustSatisfyTheInterfaceItReplaces(t *testing.T) {
	// This is the rule that makes upgrades safe. Without it, enabling
	// Fine-Grained Permissions silently breaks every caller of can().
	access := cap("kernel.access", spec.TierKernel)
	access.Exposes = []spec.Exposed{
		{Kind: "interface", Name: "can", Signature: "can(u, a, r)"},
		{Kind: "registry", Name: "permissions"},
	}
	rebac := cap("access.rebac", spec.TierUpgrade)
	rebac.Upgrades = &spec.UpgradeTarget{ID: "kernel.access", Migration: "m1"}
	rebac.Exposes = []spec.Exposed{{Kind: "interface", Name: "check", Signature: "check(s, r, o)"}}

	_, ds := Resolve(mf("access.rebac"), catalog.New(access, rebac))
	if !ds.HasErrors() {
		t.Fatal("expected an error: access.rebac does not expose can()")
	}
	found := false
	for _, d := range ds.Items() {
		if d.Check == "FORGE006" && strings.Contains(d.Message, "can") {
			found = true
			if d.Fix == "" {
				t.Error("diagnostic must name the fix")
			}
		}
	}
	if !found {
		t.Fatalf("want a FORGE006 diagnostic naming can(), got %v", ds.Items())
	}

	// A registry is contributed to, not reimplemented, so its absence is fine.
	rebac.Exposes = append(rebac.Exposes, spec.Exposed{Kind: "interface", Name: "can", Signature: "can(u, a, r)"})
	if _, ds := Resolve(mf("access.rebac"), catalog.New(access, rebac)); ds.HasErrors() {
		t.Fatalf("registries should not need reimplementing: %v", ds.Items())
	}
}

func TestTwoUpgradesCannotOccupyOneSlot(t *testing.T) {
	work := cap("kernel.work", spec.TierKernel)
	a := cap("ops.queue", spec.TierUpgrade)
	a.Upgrades = &spec.UpgradeTarget{ID: "kernel.work", Migration: "m1"}
	b := cap("ops.other", spec.TierUpgrade)
	b.Upgrades = &spec.UpgradeTarget{ID: "kernel.work", Migration: "m2"}

	_, ds := Resolve(mf("ops.queue", "ops.other"), catalog.New(work, a, b))
	if !hasCheck(ds.Items(), "FORGE005") {
		t.Fatalf("want FORGE005 for two capabilities in one upgrade slot, got %v", ds.Items())
	}
}

func TestConflictsFailAtValidateAndAreReportedOnce(t *testing.T) {
	a := cap("kernel.access", spec.TierKernel)
	b := cap("access.rebac", spec.TierCapability)
	b.Conflicts = []spec.Conflict{{ID: "kernel.access", Reason: "replaces basic roles entirely"}}

	_, ds := Resolve(mf("access.rebac"), catalog.New(a, b))
	n := 0
	for _, d := range ds.Items() {
		if d.Check == "FORGE004" {
			n++
			if !strings.Contains(d.Message, "replaces basic roles entirely") {
				t.Errorf("the declared reason must be surfaced, got %q", d.Message)
			}
		}
	}
	if n != 1 {
		t.Fatalf("conflict reported %d times, want exactly 1", n)
	}
}

func TestUnknownCapabilityNamesFileLineAndFix(t *testing.T) {
	_, ds := Resolve(mf("pay.nonexistent"), catalog.New(cap("kernel.data", spec.TierKernel)))
	if len(ds.Items()) == 0 {
		t.Fatal("expected an error for an unknown capability")
	}
	d := ds.Items()[0]
	if d.File != "forge.yaml" {
		t.Errorf("File = %q, want forge.yaml", d.File)
	}
	if d.Path != "capabilities/0/id" {
		t.Errorf("Path = %q, want capabilities/0/id", d.Path)
	}
	if d.Fix == "" {
		t.Error("every diagnostic must name a fix")
	}
}

func TestDisabledCapabilityIsExcluded(t *testing.T) {
	cat := catalog.New(cap("pay.card", spec.TierCapability))
	m := mf("pay.card")
	off := false
	m.Capabilities[0].Enabled = &off
	g, _ := Resolve(m, cat)
	if g.Has("pay.card") {
		t.Error("a capability with enabled:false must be excluded from the graph")
	}
}

func TestApplyOrderPutsDependenciesFirst(t *testing.T) {
	cat := catalog.New(
		cap("kernel.events", spec.TierKernel),
		cap("ops.queue", spec.TierCapability, "kernel.events"),
		cap("data.files", spec.TierCapability, "ops.queue"),
	)
	g, _ := Resolve(mf("data.files"), cat)
	pos := map[string]int{}
	for i, id := range g.Order {
		pos[id] = i
	}
	if pos["kernel.events"] > pos["ops.queue"] || pos["ops.queue"] > pos["data.files"] {
		t.Fatalf("apply order violates dependency order: %v", g.Order)
	}
}

func TestResolutionIsDeterministic(t *testing.T) {
	// Go randomises map iteration. Any nondeterminism here would surface as a
	// spurious diff in plan output on every run, which is a defect per the brief.
	cat := catalog.New(
		cap("kernel.data", spec.TierKernel), cap("kernel.events", spec.TierKernel),
		cap("kernel.money", spec.TierKernel), cap("kernel.identity", spec.TierKernel),
		cap("ops.queue", spec.TierCapability, "kernel.events"),
		cap("data.files", spec.TierCapability, "ops.queue", "kernel.identity"),
		cap("docs.generation", spec.TierCapability, "data.files", "kernel.data"),
		cap("pay.invoices", spec.TierCapability, "docs.generation", "kernel.money"),
	)
	first, _ := Resolve(mf("pay.invoices"), cat)
	for i := 0; i < 50; i++ {
		g, _ := Resolve(mf("pay.invoices"), cat)
		if strings.Join(g.Order, ",") != strings.Join(first.Order, ",") {
			t.Fatalf("apply order differs between runs:\n  %v\n  %v", first.Order, g.Order)
		}
	}
}

func TestRequiresCycleDoesNotHang(t *testing.T) {
	a := cap("x.a", spec.TierCapability, "x.b")
	b := cap("x.b", spec.TierCapability, "x.a")
	g, _ := Resolve(mf("x.a"), catalog.New(a, b))
	if len(g.Order) != 2 {
		t.Fatalf("both capabilities should still be ordered, got %v", g.Order)
	}
}

func hasCheck(items []diag.Diagnostic, code string) bool {
	for _, d := range items {
		if d.Check == code {
			return true
		}
	}
	return false
}
